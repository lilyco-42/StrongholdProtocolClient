# NOTES.md — `p2p-match` 的现场记录

> 按 [`权限区域.md`](权限区域.md) §6 的规程：发现别人的改动碰到我的区域，就记在这里。

## 2026-10-06 —— 发现未推送的并行改动，且正好落在我的协商区

**观察**：本仓库本地 `main` 比 `origin/main` 多一个**未推送**提交：

```
$ git log --oneline origin/main..main
e46b05a picker: 默认网友服 5 → 10 台，播种批次 SEED_VERSION 升到 2

$ git log -1 --format='%an %ad' --date=iso e46b05a
lilyco-42 <251102081+lilyco-42@users.noreply.github.com>  2026-10-06 15:21:03 +0800

$ git show --stat --format='' e46b05a
 shell/picker-core.js      | 21 +++++++++++++++++----
 test/picker-probe.test.js | 17 +++++++++++++++++
```

**影响评估**：

1. **撞区**：`shell/picker-core.js` 是我的协商区（`权限区域.md` §2，标注「尽量不改」）。
   该提交把 `COMMUNITY_SERVERS` 从 5 台改到 10 台并升了 `SEED_VERSION`。
2. **它解释了我观测到的测试数漂移**：本仓库 `AGENTS.md` §6 记的是 94/94、111/111，
   我 2026-10-06 实测是 **95/95、113/113**。差值就是 `test/picker-probe.test.js` 新增的用例。
   → 印证了 `agent.md` §1 A3 的判断：**基线只能现跑，不能引用文档**。
3. **我的处置**：建 `feat/p2p-match` 时最初从**本地 main** 切出，导致该未推送提交被一并推到了
   我的分支上。已用 `git rebase --onto origin/main e46b05a` 把分支重置为**只含我自己的提交**，
   并 `--force-with-lease` 覆盖。本地 `main` 上的 `e46b05a` **原样保留，未做任何改动**。

**对后续实现的约束（我给自己加的）**：

- 我的 P2P 房间发现必须**纯增量**：不得依赖 `COMMUNITY_SERVERS` 的具体条数或 `SEED_VERSION` 的值。
  否则 `e46b05a` 这类改动会让我的代码静默失效。
- `shell/picker-core.js` 的改动权应优先让给这条并行线。我的纯函数一律放 `shell/p2p/rooms.js`。

**留给人的问题**：`e46b05a` 该由谁推送？它现在只存在于这台机器的本地 `main` 上，
任何人在别的机器上 `git push origin main` 都会绕过它。**这是当前最大的一处 git 冲突风险点。**
