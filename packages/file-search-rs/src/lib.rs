use std::path::PathBuf;

use globset::GlobSet;
use ignore::{gitignore::GitignoreBuilder, Match, WalkBuilder};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::RwLock;
use std::sync::Arc;

/// Configuration for file search initialization
#[napi(object)]
pub struct SearchConfig {
    pub project_root: String,
    pub use_gitignore: bool,
    pub use_qwenignore: bool,
    pub ignore_dirs: Vec<String>,
    pub enable_fuzzy_search: bool,
    pub max_depth: Option<u32>,
}

/// Search result item
#[napi(object)]
pub struct SearchResult {
    pub path: String,
    pub score: Option<i32>,
}

/// Internal state for the file search engine
struct SearchEngineState {
    all_files: Vec<String>,
}

/// Build a glob set from patterns
fn build_glob_set(patterns: &[String], case_insensitive: bool) -> Option<GlobSet> {
    if patterns.is_empty() {
        return None;
    }

    let mut builder = globset::GlobSetBuilder::new();
    for pattern in patterns {
        let mut glob_builder = globset::GlobBuilder::new(pattern);
        if case_insensitive {
            glob_builder.case_insensitive(true);
        }
        if let Ok(glob) = glob_builder.build() {
            builder.add(glob);
        }
    }

    builder.build().ok()
}

/// Main file search class - wraps the Rust implementation
#[napi]
pub struct FileSearch {
    state: Arc<RwLock<SearchEngineState>>,
    project_root: String,
    config: SearchConfig,
}

#[napi]
impl FileSearch {
    /// Create a new FileSearch instance
    #[napi(constructor)]
    pub fn new(config: SearchConfig) -> Self {
        Self {
            state: Arc::new(RwLock::new(SearchEngineState {
                all_files: Vec::new(),
            })),
            project_root: config.project_root.clone(),
            config,
        }
    }

    /// Load .qwenignore patterns and build a GlobSet
    fn load_qwenignore(&self) -> Option<GlobSet> {
        self.load_ignore_file_as_globset(".qwenignore")
    }

    /// Load .gitignore patterns using GitignoreBuilder for proper negation support
    fn load_gitignore(&self) -> Option<ignore::gitignore::Gitignore> {
        let gitignore_path = PathBuf::from(&self.project_root).join(".gitignore");
        if !gitignore_path.exists() {
            return None;
        }

        let mut builder = GitignoreBuilder::new(&self.project_root);
        
        // Add patterns from .gitignore
        if let Some(e) = builder.add(&gitignore_path) {
            eprintln!("Warning: Failed to load .gitignore: {}", e);
            return None;
        }

        match builder.build() {
            Ok(gitignore) => Some(gitignore),
            Err(e) => {
                eprintln!("Warning: Failed to build gitignore: {}", e);
                None
            }
        }
    }

    /// Load an ignore file and build a GlobSet (for qwenignore)
    fn load_ignore_file_as_globset(&self, filename: &str) -> Option<GlobSet> {
        let ignore_path = PathBuf::from(&self.project_root).join(filename);
        if !ignore_path.exists() {
            return None;
        }

        let content = match std::fs::read_to_string(&ignore_path) {
            Ok(c) => c,
            Err(_) => return None,
        };

        // Process patterns - handle directory patterns
        let patterns: Vec<String> = content
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .flat_map(|pattern| {
                // Skip negation patterns for globset (they're complex)
                if pattern.starts_with('!') {
                    return vec![];
                }

                // Directory patterns (ending with /)
                if pattern.ends_with('/') {
                    let dir = pattern.trim_end_matches('/');
                    vec![
                        dir.to_string(),
                        format!("{}/", dir),
                        format!("{}/{}", dir, "**"),
                    ]
                } else {
                    vec![pattern]
                }
            })
            .collect();

        if patterns.is_empty() {
            None
        } else {
            build_glob_set(&patterns, true)
        }
    }

    /// Load ignoreDirs patterns and build a GlobSet
    fn load_ignore_dirs_set(&self) -> Option<GlobSet> {
        if self.config.ignore_dirs.is_empty() {
            return None;
        }

        // Process patterns similar to the JS implementation
        let patterns: Vec<String> = self
            .config
            .ignore_dirs
            .iter()
            .flat_map(|dir| {
                if dir.ends_with('/') {
                    let d = dir.trim_end_matches('/');
                    vec![
                        d.to_string(),
                        format!("{}/", d),
                        format!("{}/{}", d, "**"),
                    ]
                } else {
                    vec![
                        dir.to_string(),
                        format!("{}/", dir),
                        format!("{}/{}", dir, "**"),
                    ]
                }
            })
            .collect();

        build_glob_set(&patterns, true)
    }

    /// Perform fuzzy matching (character-by-character, like fzf)
    fn fuzzy_match(text: &str, pattern: &str) -> bool {
        let text_lower = text.to_lowercase();
        let pattern_lower = pattern.to_lowercase();
        let pattern_chars: Vec<char> = pattern_lower.chars().collect();
        let text_chars: Vec<char> = text_lower.chars().collect();

        let mut pattern_idx = 0;
        for &text_char in &text_chars {
            if pattern_idx < pattern_chars.len() && text_char == pattern_chars[pattern_idx] {
                pattern_idx += 1;
                if pattern_idx == pattern_chars.len() {
                    return true;
                }
            }
        }
        false
    }

    /// Initialize the search engine by crawling the filesystem
    #[napi]
    pub async fn initialize(&self) -> Result<()> {
        let project_root = PathBuf::from(&self.project_root);

        if !project_root.exists() {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Project root does not exist: {}", self.project_root),
            ));
        }

        // Load ignore patterns
        let gitignore = if self.config.use_gitignore {
            self.load_gitignore()
        } else {
            None
        };

        let qwenignore_set = if self.config.use_qwenignore {
            self.load_qwenignore()
        } else {
            None
        };

        let ignore_dirs_set = self.load_ignore_dirs_set();

        // Build the walker WITHOUT git_ignore - we handle it manually
        let mut builder = WalkBuilder::new(&project_root);

        builder
            .git_ignore(false)
            .git_global(false)
            .hidden(false)
            .follow_links(false)
            .sort_by_file_name(|a, b| a.cmp(b));

        // Add max depth if specified
        if let Some(depth) = self.config.max_depth {
            builder.max_depth(Some(depth as usize));
        }

        // Always add .git to ignore patterns
        builder.add_custom_ignore_filename(".git");

        // Perform the walk and collect files
        let mut files = Vec::new();
        let project_root_abs = project_root
            .canonicalize()
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

        for result in builder.build() {
            match result {
                Ok(entry) => {
                    let path = entry.path();

                    // Get path relative to project root
                    let relative = if path.is_absolute() {
                        match path.strip_prefix(&project_root_abs) {
                            Ok(r) => r,
                            Err(_) => continue,
                        }
                    } else {
                        path
                    };

                    let relative_str = relative.to_string_lossy().to_string();

                    // Skip empty paths and current directory
                    if relative_str.is_empty() || relative_str == "." {
                        continue;
                    }

                    // Skip .git directory entries
                    if relative_str == ".git" || relative_str.starts_with(".git/") {
                        continue;
                    }

                    // Apply gitignore filtering using Gitignore object
                    if let Some(ref gitignore_obj) = gitignore {
                        // Gitignore::matched_path_or_any_parents returns Match::Ignore if the path should be ignored
                        let match_result = gitignore_obj.matched_path_or_any_parents(path, entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false));
                        if let Match::Ignore(_) = match_result {
                            continue;
                        }
                    }

                    // Apply ignore_dirs filtering
                    if let Some(ref ignore_set) = ignore_dirs_set {
                        let mut should_skip = false;
                        let mut current = PathBuf::new();
                        for component in relative.components() {
                            current.push(component);
                            let current_str = current.to_string_lossy();
                            if ignore_set.is_match(current_str.as_ref()) {
                                should_skip = true;
                                break;
                            }
                        }
                        if should_skip {
                            continue;
                        }
                    }

                    // Apply qwenignore filtering
                    if let Some(ref qwen_set) = qwenignore_set {
                        let mut should_skip = false;
                        
                        // Check the path itself
                        if qwen_set.is_match(&relative_str) {
                            should_skip = true;
                        }
                        
                        // Also check parent directories
                        if !should_skip {
                            let mut current = PathBuf::new();
                            for component in relative.components() {
                                current.push(component);
                                let current_str = current.to_string_lossy();
                                if qwen_set.is_match(current_str.as_ref()) {
                                    should_skip = true;
                                    break;
                                }
                            }
                        }
                        
                        if should_skip {
                            continue;
                        }
                    }

                    // Format path: directories end with '/', files don't
                    let formatted_path = if entry
                        .file_type()
                        .map(|ft| ft.is_dir())
                        .unwrap_or(false)
                    {
                        format!("{}/", relative_str)
                    } else {
                        relative_str
                    };

                    files.push(formatted_path);
                }
                Err(e) => {
                    // Log error but continue (e.g., permission denied)
                    eprintln!("Warning: Error reading path: {}", e);
                }
            }
        }

        // Sort results: directories first, then alphabetically
        files.sort_by(|a, b| {
            let a_is_dir = a.ends_with('/');
            let b_is_dir = b.ends_with('/');

            match (a_is_dir, b_is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.cmp(b),
            }
        });

        // Update state
        let mut state = self.state.write();
        state.all_files = files;

        Ok(())
    }

    /// Search for files matching a pattern
    #[napi]
    pub async fn search(
        &self,
        pattern: String,
        max_results: Option<u32>,
    ) -> Result<Vec<SearchResult>> {
        let state = self.state.read();

        if state.all_files.is_empty() {
            return Err(Error::new(
                Status::GenericFailure,
                "Search engine not initialized. Call initialize() first.".to_string(),
            ));
        }

        let files = &state.all_files;
        let max = max_results.unwrap_or(u32::MAX) as usize;

        // If pattern contains glob characters, use glob matching
        if pattern.contains('*') || pattern.contains('?') || pattern.contains('[') {
            // Use case-insensitive glob matching
            let mut glob_builder = globset::GlobBuilder::new(&pattern);
            glob_builder.case_insensitive(true);

            let glob = glob_builder.build().map_err(|e| {
                Error::new(Status::InvalidArg, format!("Invalid glob pattern: {}", e))
            })?;
            let matcher = glob.compile_matcher();

            let results: Vec<SearchResult> = files
                .iter()
                .filter(|f| {
                    let clean_path = f.trim_end_matches('/');
                    matcher.is_match(f) || matcher.is_match(clean_path)
                })
                .take(max)
                .map(|path| SearchResult {
                    path: path.clone(),
                    score: None,
                })
                .collect();

            return Ok(results);
        }

        // Fuzzy search or substring matching
        if self.config.enable_fuzzy_search {
            // Use fuzzy matching (character-by-character like fzf)
            let results: Vec<SearchResult> = files
                .iter()
                .filter(|f| Self::fuzzy_match(f, &pattern))
                .take(max)
                .map(|path| SearchResult {
                    path: path.clone(),
                    score: None,
                })
                .collect();

            return Ok(results);
        } else {
            // Simple substring matching
            let pattern_lower = pattern.to_lowercase();
            let results: Vec<SearchResult> = files
                .iter()
                .filter(|f| f.to_lowercase().contains(&pattern_lower))
                .take(max)
                .map(|path| SearchResult {
                    path: path.clone(),
                    score: None,
                })
                .collect();

            return Ok(results);
        }
    }

    /// Get all crawled files (for debugging/testing)
    #[napi]
    pub fn get_all_files(&self) -> Vec<String> {
        let state = self.state.read();
        state.all_files.clone()
    }
}
