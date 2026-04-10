use globset::{Glob, GlobSetBuilder};

fn main() {
    let mut builder = GlobSetBuilder::new();
    
    // Add pattern "dist/"
    let glob = Glob::new("dist/").unwrap();
    builder.add(glob);
    
    // Add pattern "dist/**"
    let glob2 = Glob::new("dist/**").unwrap();
    builder.add(glob2);
    
    let set = builder.build().unwrap();
    let matcher = set.compile_matcher();
    
    println!("Testing pattern 'dist/' against:");
    println!("  'dist/' matches: {}", set.is_match("dist/"));
    println!("  'dist' matches: {}", set.is_match("dist"));
    println!("  'dist/file.js' matches: {}", set.is_match("dist/file.js"));
    println!("  'src/' matches: {}", set.is_match("src/"));
}
