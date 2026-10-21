#!/usr/bin/env bash
# 把一次 Release 的九个形态传到夸克网盘：GitHub-Releases/lilyco/<tag>
# 用法：`upload-release-to-quark.sh <TAG> [DIR]`
#   TAG 默认 v0.3.1-c53；DIR 默认 /d/_artifacts/${TAG##*-}（与 fetch-release.sh 对应）。
#
# 依赖：可用的 quarkpan 0.4.0（Rust 版，基于 libquarkpan，走官方动态分桶）。
#   - 优先用 $QUARKPAN_BIN；否则用 PATH 里的 quarkpan / quarkpan.exe。
#   - Windows 本地可用：/c/Users/liuqi/Downloads/_qrelease/quarkpan-x86_64-pc-windows-msvc.exe
# cookie：CLI 读 QUARK_COOKIE 环境变量，这里从 $KUAKE_COOKIE 透传。
#
# 注意：quarkpan 用 FID 定位目录，不能用路径字符串。父目录固定为 lilyco
#   fid（可用 $QUARK_PARENT_FID 覆盖），在其下建 <TAG> 文件夹后再传文件。
#   上传成功即删除本地文件（省 7GB 盘）；失败保留可手工重传。

set -uo pipefail
TAG="${1:-v0.3.1-c53}"
STAMP="${TAG##*-}"
DIR="${2:-/d/_artifacts/${STAMP}}"
QUARKPARENT="${QUARK_PARENT_FID:-f495ae415d644980985b3e7ce3838b71}"   # lilyco

# quarkpan 二进制
QUARK="${QUARKPAN_BIN:-}"
if [ -z "$QUARK" ]; then
  if command -v quarkpan.exe >/dev/null 2>&1; then QUARK="quarkpan.exe"
  elif command -v quarkpan >/dev/null 2>&1; then QUARK="quarkpan"
  else echo "找不到 quarkpan（设 QUARKPAN_BIN 或把它放进 PATH）" >&2; exit 2; fi
fi

# cookie：CLI 读 QUARK_COOKIE 环境变量
if [ -n "${KUAKE_COOKIE:-}" ]; then export QUARK_COOKIE="$KUAKE_COOKIE"; fi
if [ -z "${QUARK_COOKIE:-}" ]; then echo "没有 cookie（设 KUAKE_COOKIE 或 QUARK_COOKIE）" >&2; exit 3; fi

cd "$DIR" 2>/dev/null || { echo "没有 ${DIR}" >&2; exit 2; }

echo "=== $DIR -> GitHub-Releases/lilyco/$TAG (parent $QUARKPARENT) ==="
"$QUARK" --version

# 找 / 建 <TAG> 文件夹
TAG_FID=$("$QUARK" list --pdir-fid "$QUARKPARENT" --all --long 2>/dev/null | awk -v t="$TAG" '$NF==t {print $(NF-1)}')
if [ -z "$TAG_FID" ]; then
  echo "创建文件夹 $TAG ..."
  OUT=$("$QUARK" folder create --file-name "$TAG" --pdir-fid "$QUARKPARENT" 2>&1)
  echo "$OUT"
  TAG_FID=$(echo "$OUT" | grep -oE 'folder created: [0-9a-f]+' | awk '{print $3}')
fi
[ -n "$TAG_FID" ] || { echo "无法解析 $TAG 文件夹 fid"; exit 1; }
echo "目标文件夹 fid: $TAG_FID"

# 传 DIR 里的所有文件
shopt -s nullglob
files=(*)
fail=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
  echo "--- 上传 $f ($(( sz / 1048576 )) MB)"
  if "$QUARK" upload --file "$f" --pdir-fid "$TAG_FID" -c -o > /tmp/up.log 2>&1; then
    tail -c 2000 /tmp/up.log
    echo "  ✓ $f"; rm -f "$f"
  else
    tail -c 2000 /tmp/up.log
    echo "  ✗ $f 上传失败（保留本地）"; fail=1
  fi
done
echo "=== 完成：$TAG ==="
"$QUARK" list --pdir-fid "$TAG_FID" --all --long
[ "$fail" -eq 0 ] || echo "警告：部分文件上传失败"
