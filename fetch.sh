#!/bin/bash
# 通过指定 CF 边缘 IP + 重试拉取 worker 响应（本机 DNS 受污染，必须 --resolve）
# 用法: ./fetch.sh <host> <path> [outfile]   outfile 用相对/Windows 路径
HOST="${1:-lxprobe.zyplnn.dpdns.org}"
REQPATH="${2:-/}"
OUT="${3:-_out.json}"
export PATH="/c/Users/zhangyanpu/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:/usr/bin:/bin:/c/windows/system32:/c/windows:$PATH"
IPS="104.21.10.218 172.67.146.203 104.21.10.219 172.67.146.204 104.21.10.141 172.67.146.111"
for attempt in 1 2 3 4 5 6 7 8; do
  for ip in $IPS; do
    code=$(curl -s --noproxy '*' --max-time 30 --resolve "$HOST:443:$ip" -o "$OUT" -w "%{http_code}" "https://$HOST$REQPATH" 2>/dev/null)
    if [ "$code" = "200" ]; then echo "OK ip=$ip attempt=$attempt -> $OUT"; exit 0; fi
  done
  sleep 2
done
echo "FAILED after attempts (last code=$code)"; exit 1
