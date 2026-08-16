#!/usr/bin/env bash
# One-time container setup: put the ~1 GB real-history mirror on container-local
# disk and make it behave like github.com does for a fetch (any-SHA wants).
set -euo pipefail

SRV=/runner/srv
mkdir -p "$SRV/QwenLM" /runner/_temp /out
cp -a /verify/fixture/srv/QwenLM/qwen-code.git "$SRV/QwenLM/qwen-code"
git -C "$SRV/QwenLM/qwen-code" config uploadpack.allowAnySHA1InWant true
git -C "$SRV/QwenLM/qwen-code" config uploadpack.allowReachableSHA1InWant true
git -C "$SRV/QwenLM/qwen-code" config uploadpack.allowFilter true
git -C "$SRV/QwenLM/qwen-code" config core.bare true
# Make the advertisement look like a real origin: heads + tags only.
git -C "$SRV/QwenLM/qwen-code" for-each-ref --format='%(refname)' \
  | grep -Ev '^refs/(heads|tags)/' \
  | while read -r r; do git -C "$SRV/QwenLM/qwen-code" update-ref -d "$r"; done

echo "mirror bytes: $(du -sb "$SRV/QwenLM/qwen-code" | cut -f1)"
echo "mirror du -sh: $(du -sh "$SRV/QwenLM/qwen-code" | cut -f1)"
echo "heads: $(git -C "$SRV/QwenLM/qwen-code" for-each-ref --format='%(refname)' refs/heads | wc -l)"
echo "tags:  $(git -C "$SRV/QwenLM/qwen-code" for-each-ref --format='%(refname)' refs/tags | wc -l)"
for sha in "$@"; do
  if git -C "$SRV/QwenLM/qwen-code" cat-file -e "$sha^{commit}" 2>/dev/null; then
    echo "have $sha"
  else
    echo "MISSING $sha"
    exit 1
  fi
done
git config --global user.email runner@example.com
git config --global user.name runner
git config --global init.defaultBranch main
echo SETUP_OK
