# magpie-codex-route-monitor

一个 magpie 插件：**监测 Codex 账号的路由质量**。它用 Codex CLI 的非交互接口，让每个账号按
[ModelTrace](https://github.com/xqy2006/ModelTrace) 的三组随机数挑战各生成三次数字，再用 ModelTrace
的算法和指纹库判断「到底是哪个模型在回答」；回答落在 **GPT-5.6 Luna / GPT-6 Luna** 上，说明这个账号
被风控、请求被降级，插件会把它在 magpie 里**停用**；回答是别的模型则**启用**。

- 每天 **00:00** 测**全部** Codex 账号（含已停用的），按结果启用/停用；
- 每天 **03:00 / 06:00 / 09:00 / 12:00 / 15:00 / 18:00 / 21:00** 只测**正在启用**的账号，结果为 Luna 就停用。

> 判定规则来自使用者的要求：诊断结果 top-1 是 `gpt-5.6-luna` 或 `gpt-6-luna` ⇒ 账号被风控。

---

## 它怎么工作

1. **读账号**：`magpie accounts codex --json` 取账号清单，`magpie provider pool codex` 取「谁正在启用」
   （`accounts --json` 里，Codex 当前登录的那个账号永远显示 `on`，即使 magpie 正跳过它，所以启用状态
   必须从 pool 报告读）。
2. **逐个探测**：为账号单独准备一个临时 `CODEX_HOME`，里面只有一份 config.toml，指向 magpie 网关的
   `/v1`，并用 `X-Magpie-Account: <邮箱>` 把请求钉死在**这一个**账号上；`codex exec` 以
   `codex/gpt-6.1-sol`、`model_reasoning_effort=low`、`--skip-git-repo-check --ephemeral` 跑三条挑战，
   提示词走 stdin，不出现在命令行里。
   为什么不直接拿账号 token 去连 OpenAI：magpie 持有并会刷新这些登录态，复制 refresh token 有把账号
   登出的风险；走网关 + 钉账号既隔离又不动登录态。
3. **归因**：把三份回答交给 ModelTrace 算法（Hellinger + 有序块特征、去干扰方向、softmax 校准），得到
   top-1 模型与概率。实现是 `fingerprint.py` 的逐行 JS 移植，`npm test` 里有一致性测试用 ModelTrace
   自己的 Python 结果做基准（误差 < 1e-9）。
4. **落状态**：Luna ⇒ 停用，其它 ⇒ 启用，无法诊断（超时、429、截断）⇒ **保持原状**。
   启停通过 `magpie provider pool codex --accounts <健康账号…>` 完成：列出的账号启用、其余停用；
   当前登录账号的「停用」在 magpie 里表现为 `paused`（网关跳过它，登录态保留）。
   如果**全部**账号都测出 Luna，magpie 的命令行无法表达「一个都不启用」，插件会把
   `~/.config/magpie/logins.json` 里 Codex 账号写成 `on:false`/`paused:true`（先留备份
   `logins.json.codex-route-monitor.bak`），再用 `provider pool` 读回来核验。

一次扫描的流程图：

```text
lock ──▶ magpie healthcheck ──▶ accounts + pool ──▶ for each account
                                                     ├─ 需要时临时启用（只为钉住它）
                                                     ├─ 3 × codex exec（挑战→数字）
                                                     ├─ ModelTrace 归因
                                                     └─ risk → 关 / ok → 开 / error → 不动
                                                   ──▶ provider pool 一次性落地并核验
                                                   ──▶ state.json + runs/<id>.json + logs/
```

## 安装

插件已发布为公开仓库，标签 `magpie-plugin`。装到本机和 192.168.80.105 的 magpie：

```bash
magpie plugin add github:para1lel/codex-route-monitor
magpie plugin list                 # 应看到 magpie-codex-route-monitor，且为 on
```

105 是 headless 的 magpie 服务，直接在同一条 ssh 里装：

```bash
ssh 192.168.80.105 'magpie plugin add github:para1lel/codex-route-monitor && magpie plugin list'
```

装好后插件宿主会加载 `index.js`，立刻启动定时器（每 20 秒检查一次是否有到点的时段）。

> 本机是桌面版 magpie，只有 magpie 在跑时插件才有心跳；如果希望「关机/退出 magpie 也不漏」，
> 用下面的 `install-schedule` 再挂一层系统定时器（两者按「时段」去重，不会重复扫描），
> 或者至少 `magpie autostart on`。

## 验证

```bash
# 环境自检：magpie、网关、账号、指纹库、codex CLI、状态目录
node bin/codex-route-monitor.mjs doctor        # 仓库目录里；或用 npx

# 只测一个账号，不改任何状态（最常用的手工检查）
node bin/codex-route-monitor.mjs probe --account woshijuruo@gmail.com

# 看最近结果
node bin/codex-route-monitor.mjs status
node bin/codex-route-monitor.mjs status --json
```

magpie 侧的两个工具（MCP 名以插件短名为前缀）：

```bash
magpie tools | grep -i codex        # 列出工具
magpie tool magpie-codex-route-monitor_codex_route_status
magpie tool magpie-codex-route-monitor_codex_route_scan --scope all
```

`codex_route_scan` 只负责**启动**（扫描是独立进程，几分钟才结束），结果用 `codex_route_status` 或
`node bin/codex-route-monitor.mjs status` 看。

## 定时

| 时间（本地时区） | 范围 | 行为 |
| --- | --- | --- |
| 00:00 | `all` | 测全部账号（含停用的），Luna→停用，其它→启用；停用账号会为探测临时启用，测完按结果落地 |
| 03:00…21:00 每 3 小时 | `enabled` | 只测正在启用的账号；Luna→停用，其它保持启用 |

- 漏跑补跑：00:00 的全量在**当天内**都可以补跑；整三小时的时段只在开始后 **120 分钟**内补跑。
- 「正在跑」的时段超过 **45 分钟**没落地，视为进程已死，下一个 tick 会重新发起。
- 同一时刻只允许一个扫描（`scan.lock`），插件心跳、手工命令、系统定时器三者互斥。
- 时段记录在 `state.json` 的 `slots` 里，`node bin/codex-route-monitor.mjs schedule` 可以看。

可选：额外的系统定时器（Windows 计划任务 / systemd --user timer），两者都调用
`scan --scope auto`——只有「该跑的时段」才真正扫描，和插件心跳去重：

```bash
node bin/codex-route-monitor.mjs install-schedule          # 安装
node bin/codex-route-monitor.mjs install-schedule --dry-run
node bin/codex-route-monitor.mjs uninstall-schedule
```

## 配置

`~/.config/magpie/codex-route-monitor/config.json`（不存在则用默认值；改完下一次扫描生效）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `model` | `codex/gpt-6.1-sol` | 探测用的模型；`codex/<id>` 表示 Codex 订阅自己的模型 |
| `effort` | `low` | `model_reasoning_effort` |
| `probes` | `3` | 一次诊断要几条可用的回答（对应 ModelTrace 的校准 key） |
| `probeAttempts` | `6` | 最多尝试几次（被拒答/截断会换一条再问） |
| `probeTimeoutMs` | `300000` | 单条挑战的超时 |
| `pauseMs` | `3000` | 账号之间的间隔 |
| `slots` | `[0,3,6,9,12,15,18,21]` | 本地时区的整点；第一个是「全量」时段 |
| `catchUpMinutes` | `120` | 整三小时时段的补跑窗口 |
| `riskModels` | `["gpt-5.6-luna","gpt-6-luna"]` | top-1 命中即判定为风控 |
| `dryRun` | `false` | 只报告，不改 magpie 的开关 |
| `scheduler` | `true` | 是否在插件宿主里跑定时器 |
| `gatewayUrl` | 自动 | 默认 `http://127.0.0.1:3425`（插件里取 `MAGPIE_ADDR`） |
| `gatewayKey` | `magpie` | 请求网关用的 key（本机默认值） |

环境变量：`CODEX_ROUTE_MONITOR_HOME`（状态目录）、`CODEX_ROUTE_MONITOR_GATEWAY`、`CODEX_ROUTE_MONITOR_MAGPIE`、
`CODEX_ROUTE_MONITOR_CODEX`、`CODEX_ROUTE_MONITOR_BANK`。

## 状态与日志

状态目录：`~/.config/magpie/codex-route-monitor/`

```text
config.json            设置
state.json             每个账号最后一次结论、每个时段的状态、最后一次扫描
runs/<时间>/run.json   一次扫描的完整记录（每条挑战的数字条数、top-5 模型与概率、失败原因）
runs/<时间>/codex-home 临时 CODEX_HOME（跑完即删）
logs/monitor.log       插件与命令行的日志
logs/scan-<时间>.log   每次扫描的一行式摘要
scan.lock              互斥锁
```

`run.json` 里 `outputs` 保存原始回答文本，排查「为什么判成 Luna」时最有用。

## 与 lingsuan 兜底的关系

插件只做一件事：**改 Codex 账号的启停**。当它把所有（或部分）账号停用后，GPT 模型的可用性由 magpie
的**路由组**兜底——本机和 105 上都已把 `lingsuan.org`（`lingsuan-gpt`）的 GPT 模型接到这些组的第二位，
路由顺序是 `order`：先 Codex 账号，Codex 没有可用账号/失败时才走 lingsuan。

| 路由组 | 成员顺序 |
| --- | --- |
| `group/gpt-6.1-sol` / `group/gpt-6.1-terra` | `codex/…` → `lingsuan-gpt/…` |
| `group/gpt-6-sol` / `group/gpt-6-astra` | `codex/…` → `lingsuan-gpt/…` |
| `group/gpt-5.6-sol` / `group/gpt-5.6-terra` | `codex/…` → `lingsuan-gpt/…` |
| `group/gpt-5.6-luna` / `group/gpt-6-luna` | `codex/…` →（原有的 opencode-go）→ `lingsuan-gpt/…` |

两台机器的 Codex 代理模型都设为 `group/gpt-6.1-terra`，因此 Codex 账号全被停用时，Codex 仍然由
lingsuan 提供 GPT-6.1 Terra；其它代理用 `group/gpt-6.1-sol` 的也同理。

## 开销与注意

- 每条挑战在 Codex 上约 12k 输入 + 数百输出 token；一个账号一轮 3 条，大约 4 万 token。
  按每天 8 轮、2 个账号算，约 60 万 token/天，全部消耗在对应账号的 Codex 额度里。
- 探测是**真实的模型请求**，和被风控的账号共用额度；请勿把 `probes` 调太大。
- 探测走 magpie 网关，不修改、不复制任何账号 token。
- 扫描期间会把「原本停用」的账号临时启用（仅为了钉住它），一条探测完立刻按结果落地；
  00:00 的全量扫描因此会有几分钟的「账号在启用状态」窗口。
- 账号全部风控时，脚本会写 magpie 的 `logins.json`（有备份）并核验；这是唯一一处直接改 magpie 文件，
  因为命令行无法表达「一个都不启用」。

## 局限

- ModelTrace 是**闭集归因**：结果只在指纹库的 18 个模型里取最近邻，库外模型也会被归到某个库内模型。
  当前库里有 `gpt-5.4 / 5.5 / 5.6-sol / 5.6-terra / 5.6-luna / 6-astra / 6-sol / 6-luna` 和 10 个 Claude 模型，
  **没有 gpt-6.1 系列**——所以对 `gpt-6.1-sol` 的回答只能给出「最像谁」。Luna 的分布很有辨识度，
  这也是本插件按 top-1 Luna 判风控的依据；但它是统计判断，不是厂商的确定性证据。
- 指纹对系统提示词敏感（ModelTrace 自己也这么提醒）。本项目用固定的最小 `CODEX_HOME`，保证同一台机器上
  每次探测环境一致；但不同环境下同一个模型的结果可能整体漂移。
- 想校准「本机是否可以跑通」，可以先对 lingsuan 的模型做一次 `probe --no-pin`：如果它给出非 Luna 的结果，
  说明 Luna 不是「所有请求都会得到」的答案。

## 卸载

```bash
magpie plugin rm magpie-codex-route-monitor     # 名字以 magpie plugin list 为准
node bin/codex-route-monitor.mjs uninstall-schedule   # 如果装过系统定时器
```

插件不保存任何账号凭据；确认不需要后可以删除 `~/.config/magpie/codex-route-monitor/`。

## 开发

```bash
node --test "test/*.test.mjs"      # 单元测试 + 与 ModelTrace Python 实现的一致性测试
node test/parity/make-inputs.mjs   # 重新生成一致性测试输入
MODELTRACE_DIR=/path/to/ModelTrace python test/parity/check.py  # 用 ModelTrace 生成期望值
```

目录：

```text
index.js              magpie 插件入口：两个工具 + 启动定时器
bin/                  codex-route-monitor 命令行
lib/challenges.mjs    ModelTrace 的随机数挑战（措辞未改）
lib/fingerprint.mjs   fingerprint.py 的 JS 移植
lib/probe.mjs         codex exec 的隔离 CODEX_HOME 与超时处理
lib/policy.mjs        判定规则
lib/core.mjs          扫描编排、落地、记录
lib/schedule.mjs      时段、补跑、去重
lib/magpie.mjs        magpie 命令行的封装
lib/alloff.mjs        「全部风控」时唯一的一处文件兜底
data/unified_bank.json  ModelTrace 指纹库副本
```

## 许可与致谢

MIT。算法与指纹库来自 [ModelTrace](https://github.com/xqy2006/ModelTrace)（MIT，(c) 2026 xqy2006），
详见 [NOTICE](NOTICE)。magpie 插件接口、`X-Magpie-Account`、`magpie provider pool` 来自
[magpie](https://github.com/yetone/magpie)（MIT）。

---

## English

`magpie-codex-route-monitor` is a magpie plugin that keeps a fleet of Codex accounts honest. Every three
hours (and over every account at midnight) it asks each account, through `codex exec` with the
`X-Magpie-Account` header pinning one account, the three random-number challenges from
[ModelTrace](https://github.com/xqy2006/ModelTrace). A JavaScript port of ModelTrace's fingerprint —
held to the original's own answers by a parity test — says which model answered. An account whose top
answer is **GPT-5.6 Luna** or **GPT-6 Luna** is being held back, and the plugin switches it off in magpie
(`magpie provider pool codex`); any other answer switches it on. Accounts it cannot diagnose are left as
they are. The schedule runs inside magpie's plugin host, and an optional OS schedule (Windows Task
Scheduler or systemd user timers) calls the same slot-aware `scan --scope auto`, so the two never double up.

Install: `magpie plugin add github:para1lel/codex-route-monitor`.
