#!/usr/bin/env python3
"""
用 GitHub Git Data API 推送（`github.com:443` 的 git 协议不通时的备用通道）。

## 什么时候用它

2026-10-23 起本机连 `github.com:443` 直连超时、走本地代理 502，但
`api.github.com` 两条路都通。`git push` 完全没戏，而 CI（docker / apk）
只认仓库内容，所以改走 REST API。

先探一下再决定用哪条路：

    curl -s -m 15 --noproxy '*' -o /dev/null -w '%{http_code}\\n' https://github.com
    curl -s -m 15 --noproxy '*' -o /dev/null -w '%{http_code}\\n' https://api.github.com

## 做法

以远端 main 为 parent、本地 HEAD 的 tree 为目标，逐个上传改动的 blob：

    GET   /git/ref/heads/main        拿远端 sha（必须等于本地 HEAD~1，否则中止）
    POST  /git/blobs                 每个改动文件一个（base64）
    POST  /git/trees                 base_tree = 远端 tree，只覆盖改动文件
    POST  /git/commits               author/committer/date/message 照抄本地
    PATCH /git/refs/heads/main       移动分支

author/date 照抄本地是为了让 tree 与本地一致（实测 commit sha 仍会不同，
因为 API 的 date 序列化有差异 —— 内容一样就够了）。

## ⚠ 两个必知的后果

1. **远端 sha ≠ 本地 sha**（tree 相同）。下次 `git push` 会 non-fast-forward：
   先 `git fetch origin main` + `git rebase origin/main`（patch 已应用会被跳过），
   或 `git push --force`（内容相同，force 无害）。
2. **长 commit message 不能直接塞 `curl -d`** —— Windows 上会撞
   `FileNotFoundError: [WinError 206] 文件名或扩展名太长`。必须写临时文件用 `-d @file`。

## 用法

    python tools/gh-push-api.py --repo dszz453/lxmusic --token <ghp_...> \\
        --cwd <仓库目录> [--dry-run]

token 也可以用环境变量 `GH_TOKEN`。
"""
import argparse
import base64
import datetime
import json
import os
import subprocess
import sys
import tempfile

API = 'https://api.github.com'


def make_api(token):
    def api(method, path, body=None):
        cmd = ['curl', '-s', '-m', '90', '--noproxy', '*', '-X', method,
               '-H', 'Authorization: token ' + token,
               '-H', 'Accept: application/vnd.github+json',
               '-H', 'User-Agent: workbuddy',
               API + path]
        tmp = None
        if body is not None:
            fd, tmp = tempfile.mkstemp(suffix='.json')
            with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                json.dump(body, fh, ensure_ascii=False)
            cmd += ['-H', 'Content-Type: application/json', '-d', '@' + tmp]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True,
                                 encoding='utf-8').stdout
        finally:
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        try:
            return json.loads(out) if out.strip() else {}
        except Exception:
            print('非 JSON 响应:', out[:300])
            return {}
    return api


def who(line):
    """把 `author workbuddy <a@b> 1792728233 +0800` 转成 API 要的对象"""
    parts = line.split(' ', 1)[1]
    name_email, rest = parts.rsplit('>', 1)
    name, email = name_email.split(' <')
    ts, tz = rest.strip().split(' ')
    tz_min = int(tz[3:5])
    dt = datetime.datetime.fromtimestamp(int(ts), datetime.timezone(
        datetime.timedelta(hours=int(tz[:3]), minutes=tz_min)))
    return {'name': name, 'email': email, 'date': dt.isoformat()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True, help='owner/name')
    ap.add_argument('--token', default=os.environ.get('GH_TOKEN', ''))
    ap.add_argument('--cwd', default='.', help='本地仓库目录')
    ap.add_argument('--branch', default='main', help='远端分支（默认 main）')
    ap.add_argument('--from', dest='base', default='HEAD~1', help='对比基线（默认 HEAD~1）')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    if not a.token:
        print('缺少 --token 或 GH_TOKEN'); return 2

    cwd = os.path.abspath(a.cwd)

    def git(*args):
        return subprocess.run(['git'] + list(args), cwd=cwd, capture_output=True,
                              text=True, encoding='utf-8').stdout.strip()

    api = make_api(a.token)

    head = git('rev-parse', 'HEAD')
    parent = git('rev-parse', a.base)
    tree_sha = git('rev-parse', 'HEAD^{tree}')
    raw = git('cat-file', '-p', 'HEAD').split('\n')
    author_line = [l for l in raw if l.startswith('author ')][0]
    committer_line = [l for l in raw if l.startswith('committer ')][0]
    message = git('log', '-1', '--pretty=%B')

    print('本地 HEAD   =', head[:8])
    print('本地 base   =', parent[:8])
    print('本地 tree   =', tree_sha[:8])

    ref = api('GET', '/repos/%s/git/ref/heads/%s' % (a.repo, a.branch))
    remote_sha = (ref.get('object') or {}).get('sha', '')
    print('远端 %-6s = %s' % (a.branch, remote_sha[:8] if remote_sha else '(取不到)'))
    if not remote_sha:
        print('取不到远端 ref，中止'); return 1
    if remote_sha == head:
        print('远端已经是最新，无需推送'); return 0

    remote_commit = api('GET', '/repos/%s/git/commits/%s' % (a.repo, remote_sha))
    remote_tree = (remote_commit.get('tree') or {}).get('sha', '')
    base_tree = git('rev-parse', a.base + '^{tree}')

    if remote_sha != parent:
        # ⚠ 允许「sha 不同但内容相同」：之前用本工具推过之后，远端 commit 的
        #    sha 与本地不同（API 的 date 序列化有差异），但 tree 完全一样。
        #    这种情况以远端 sha 为 parent 继续推，不会覆盖任何东西。
        if remote_tree and remote_tree == base_tree:
            print('远端 sha ≠ 本地 base，但 tree 相同（%s）→ 内容一致，以远端为 parent 继续'
                  % base_tree[:8])
        else:
            print('⚠ 远端内容与本地 base 不同（tree %s vs %s）—— 有本地没有的提交，中止以免覆盖'
                  % ((remote_tree or '?')[:8], base_tree[:8]))
            return 1

    changed = [f for f in git('diff', '--name-only', parent, head).split('\n') if f.strip()]
    print('改动文件:', changed)
    if not changed:
        print('没有改动，中止'); return 1

    if a.dry_run:
        print('--dry-run：到此为止'); return 0

    entries = []
    for rel in changed:
        data = open(os.path.join(cwd, rel), 'rb').read()
        r = api('POST', '/repos/%s/git/blobs' % a.repo,
                {'content': base64.b64encode(data).decode(), 'encoding': 'base64'})
        sha = r.get('sha', '')
        if not sha:
            print('blob 上传失败:', rel, str(r)[:200]); return 1
        print('  blob %-28s %s  (%d bytes)' % (rel, sha[:8], len(data)))
        entries.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': sha})

    t = api('POST', '/repos/%s/git/trees' % a.repo,
            {'base_tree': remote_tree, 'tree': entries})
    new_tree = t.get('sha', '')
    if not new_tree:
        print('tree 创建失败:', str(t)[:300]); return 1
    print('新 tree     =', new_tree[:8],
          '（与本地一致 ✓）' if new_tree == tree_sha else '⚠ 与本地 tree 不同')

    c = api('POST', '/repos/%s/git/commits' % a.repo, {
        'message': message,
        'tree': new_tree,
        'parents': [remote_sha],
        'author': who(author_line),
        'committer': who(committer_line),
    })
    new_commit = c.get('sha', '')
    if not new_commit:
        print('commit 创建失败:', str(c)[:300]); return 1
    print('新 commit   =', new_commit[:8],
          '（与本地一致 ✓）' if new_commit == head
          else '⚠ 与本地不同（内容相同，后续 push 需 fetch+rebase 或 --force）')

    u = api('PATCH', '/repos/%s/git/refs/heads/%s' % (a.repo, a.branch),
            {'sha': new_commit, 'force': False})
    ok = (u.get('object') or {}).get('sha', '')
    print('更新分支    =', ok[:8] if ok else '失败: ' + str(u)[:250])
    return 0 if ok == new_commit else 1


if __name__ == '__main__':
    sys.exit(main())
