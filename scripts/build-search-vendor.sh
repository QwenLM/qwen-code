#!/usr/bin/env bash

set -euo pipefail

if [ "$(uname -s)" != Darwin ]; then
  printf 'Search vendor binaries must be built on macOS.\n' >&2
  exit 1
fi

root_dir=$(cd "$(dirname "$0")/.." && pwd)
vendor_dir="$root_dir/packages/core/vendor"
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

bfs_version=4.1.4
bfs_sha256=0cac6849efb8a9447268fb273de3fab38f8460adb26a1770934e3f325fab8f5d
ugrep_version=7.8.4
ugrep_sha256=b16b3503e80890c78a5c845f8c141f239f3904359f1e41900ca566c86e120172
ugrep_windows_sha256=e1d982675554faf8bc7f17654e79922e454505f078b722d0fd46bbc353aecf4f
zig_version=0.14.1
case "$(uname -m)" in
  arm64 | aarch64)
    zig_host_arch=aarch64
    zig_sha256=39f3dc5e79c22088ce878edc821dedb4ca5a1cd9f5ef915e9b3cc3053e8faefa
    ;;
  x86_64)
    zig_host_arch=x86_64
    zig_sha256=b0f8bdfb9035783db58dd6c19d7dea89892acc3814421853e5752fe4573e5f43
    ;;
  *)
    printf 'Unsupported macOS build host architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

download() {
  local url=$1
  local destination=$2
  local sha256=$3
  curl -fsSL "$url" -o "$destination"
  printf '%s  %s\n' "$sha256" "$destination" | shasum -a 256 -c -
}

download \
  "https://github.com/tavianator/bfs/archive/refs/tags/$bfs_version.tar.gz" \
  "$work_dir/bfs.tar.gz" \
  "$bfs_sha256"
download \
  "https://github.com/Genivia/ugrep/archive/refs/tags/v$ugrep_version.tar.gz" \
  "$work_dir/ugrep.tar.gz" \
  "$ugrep_sha256"
download \
  "https://ziglang.org/download/$zig_version/zig-$zig_host_arch-macos-$zig_version.tar.xz" \
  "$work_dir/zig.tar.xz" \
  "$zig_sha256"
download \
  "https://github.com/Genivia/ugrep/releases/download/v$ugrep_version/ugrep-windows-x64.zip" \
  "$work_dir/ugrep-windows.zip" \
  "$ugrep_windows_sha256"

tar -xzf "$work_dir/bfs.tar.gz" -C "$work_dir"
tar -xzf "$work_dir/ugrep.tar.gz" -C "$work_dir"
tar -xJf "$work_dir/zig.tar.xz" -C "$work_dir"
unzip -q "$work_dir/ugrep-windows.zip" -d "$work_dir/ugrep-windows"

build_bfs_macos() {
  local arch=$1
  local clang_arch=$arch
  if [ "$arch" = x64 ]; then
    clang_arch=x86_64
  fi
  local build_dir="$work_dir/bfs-$arch-darwin"
  cp -R "$work_dir/bfs-$bfs_version" "$build_dir"
  (
    cd "$build_dir"
    env \
      CC=clang \
      CFLAGS="-arch $clang_arch -mmacosx-version-min=12.0" \
      LDFLAGS="-arch $clang_arch -mmacosx-version-min=12.0" \
      ./configure \
        --enable-release \
        --without-libacl \
        --without-libcap \
        --without-libselinux \
        --without-liburing \
        --without-oniguruma
    # New SDK headers expose APIs unavailable at the macOS 12 deployment target.
    perl -pi -e \
      's/#define BFS_HAS_PIPE2 true/#define BFS_HAS_PIPE2 false/; s/#define BFS_HAS_POSIX_SPAWN_ADDFCHDIR true/#define BFS_HAS_POSIX_SPAWN_ADDFCHDIR false/' \
      gen/config.h
    make -j"$(sysctl -n hw.logicalcpu)"
    strip -S bin/bfs
  )
  install -m 755 "$build_dir/bin/bfs" "$vendor_dir/bfs/$arch-darwin/bfs"
}

build_ugrep_macos() {
  local arch=$1
  local clang_arch=$arch
  local configure_arch=aarch64
  if [ "$arch" = x64 ]; then
    clang_arch=x86_64
    configure_arch=x86_64
  fi
  local build_dir="$work_dir/ugrep-$arch-darwin"
  cp -R "$work_dir/ugrep-$ugrep_version" "$build_dir"
  (
    cd "$build_dir"
    env \
      CC=clang \
      CXX=clang++ \
      CFLAGS="-O3 -arch $clang_arch -mmacosx-version-min=12.0" \
      CXXFLAGS="-O3 -arch $clang_arch -mmacosx-version-min=12.0" \
      LDFLAGS="-arch $clang_arch -mmacosx-version-min=12.0" \
      ./configure \
        --host="$configure_arch-apple-darwin" \
        --without-pcre2 \
        --without-boost-regex \
        --without-zlib \
        --without-bzlib \
        --without-lzma \
        --without-lz4 \
        --without-zstd \
        --without-brotli \
        --without-bzip3
    # Preserve release-generated autotools files instead of requiring maintainer tools.
    touch configure
    touch config.status
    make -j"$(sysctl -n hw.logicalcpu)"
    strip -S bin/ugrep
  )
  install -m 755 "$build_dir/bin/ugrep" "$vendor_dir/ugrep/$arch-darwin/ugrep"
}

build_linux() {
  local arch=$1
  local zig_target=$2
  local cc="$work_dir/zig-cc-$arch"
  local cxx="$work_dir/zig-cxx-$arch"
  local ar="$work_dir/zig-ar-$arch"
  local ranlib="$work_dir/zig-ranlib-$arch"
  local zig="$work_dir/zig-$zig_host_arch-macos-$zig_version/zig"
  local bfs_build="$work_dir/bfs-$arch-linux"
  local ugrep_build="$work_dir/ugrep-$arch-linux"

  printf '#!/bin/sh\nexec %s cc -target %s "$@"\n' "$zig" "$zig_target" >"$cc"
  printf '#!/bin/sh\nexec %s c++ -target %s "$@"\n' "$zig" "$zig_target" >"$cxx"
  printf '#!/bin/sh\nexec %s ar "$@"\n' "$zig" >"$ar"
  printf '#!/bin/sh\nexec %s ranlib "$@"\n' "$zig" >"$ranlib"
  chmod +x "$cc" "$cxx" "$ar" "$ranlib"

  cp -R "$work_dir/bfs-$bfs_version" "$bfs_build"
  (
    cd "$bfs_build"
    env CC="$cc" LDFLAGS="-static -s" ./configure \
      --enable-release \
      --without-libacl \
      --without-libcap \
      --without-libselinux \
      --without-liburing \
      --without-oniguruma
    make -j"$(sysctl -n hw.logicalcpu)"
  )
  install -m 755 "$bfs_build/bin/bfs" "$vendor_dir/bfs/$arch-linux/bfs"

  cp -R "$work_dir/ugrep-$ugrep_version" "$ugrep_build"
  (
    cd "$ugrep_build"
    env CC="$cc" CXX="$cxx" AR="$ar" RANLIB="$ranlib" LDFLAGS="-static -s" ./configure \
      --host="$zig_target" \
      --enable-static \
      --without-pcre2 \
      --without-boost-regex \
      --without-zlib \
      --without-bzlib \
      --without-lzma \
      --without-lz4 \
      --without-zstd \
      --without-brotli \
      --without-bzip3
    # Preserve release-generated autotools files instead of requiring maintainer tools.
    touch configure
    touch config.status
    make -j"$(sysctl -n hw.logicalcpu)"
  )
  install -m 755 "$ugrep_build/bin/ugrep" "$vendor_dir/ugrep/$arch-linux/ugrep"
}

mkdir -p \
  "$vendor_dir/bfs/arm64-darwin" \
  "$vendor_dir/bfs/arm64-linux" \
  "$vendor_dir/bfs/x64-darwin" \
  "$vendor_dir/bfs/x64-linux" \
  "$vendor_dir/ugrep/arm64-darwin" \
  "$vendor_dir/ugrep/arm64-linux" \
  "$vendor_dir/ugrep/x64-darwin" \
  "$vendor_dir/ugrep/x64-linux" \
  "$vendor_dir/ugrep/x64-win32"

build_bfs_macos arm64
build_bfs_macos x64
build_ugrep_macos arm64
build_ugrep_macos x64
build_linux arm64 aarch64-linux-musl
build_linux x64 x86_64-linux-musl

install -m 644 "$work_dir/bfs-$bfs_version/LICENSE" "$vendor_dir/bfs/LICENSE"
install -m 644 "$work_dir/ugrep-$ugrep_version/LICENSE.txt" "$vendor_dir/ugrep/LICENSE.txt"
find "$work_dir/ugrep-windows" -name ugrep.exe -exec install -m 755 {} "$vendor_dir/ugrep/x64-win32/ugrep.exe" \;

file "$vendor_dir"/bfs/*/bfs "$vendor_dir"/ugrep/*/ugrep*
