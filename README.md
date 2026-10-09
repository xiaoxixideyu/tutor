# tutor（导师）

一个个性化教学 agent：从需求澄清、教研、摸底、规划，到讲授、检验、复习，全程因材施教。

- **设计文档**：[docs/design.md](docs/design.md)
- **技术基座**：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（插件组装 + 会话日志）
- **设计参考**：Reasonix 的缓存优先循环、工具调用修复、成本控制；当前已实现按课组织上下文和成本估算，完整自定义循环与分级调度仍待实现
- **模型接入**：OpenAI 兼容接口（base_url + api_key + model），不绑定单一供应商
- **交互形态**：命令行 + 本地网页，单用户，可管理多门课程；网页同时运行一个教学流程

## 状态

当前支持多课程管理、访谈与可选教研、摸底、教学计划、讲授、小测、实践、里程碑考试、间隔复习和课堂审计，并有看板／向导／课堂／复习／大考／实践与模型设置网页。Go 切片与公平骰子概率两门各两节微课已完成真实模型驱动的工程闭环，**可以开始有人陪同的小规模真人试学**。

最新更新（2026-10-09）：修复长课程联网教研反复超时与返工，改为逐点保存、硬性搜索预算、复用未变化内容的审查，并补齐资料审查的课程上下文。课程详情可查看进度、单点补查；模型渠道和教研时限可在网页保存，新流程自动采用。273 项自动测试及类型检查通过。真实渠道仍出现间歇 404 和搜索容量错误，39 节长课尚未完成整课验收，见 [教研修复实测](docs/research-recovery-2026-10-09.md) 与 [模型设置](docs/model-settings.md)。

试学就绪验收（2026-10-09 上海时间，日志日期为 UTC 2026-10-08）：当时 245 项自动测试及类型检查通过；完成内容错误回归、失败断点恢复、实践负例、考试暂停与成绩刷新、正常复习与答错后的补救。两门课现有内容均审查通过，原错误、失败、费用和受控数据迁移完整保留。详细结果、证据及限制见 [工程验收报告](docs/readiness-2026-10-08.md)。

真人学习效果尚未验证。模型仍有间歇服务错误和较长等待，实践也没有操作系统级文件与网络沙箱，当前适用于本机单用户试学。按 [真人试学手册](docs/human-trial.md) 为每位参加者启动空白独立目录：

```sh
npm run trial -- --learner p01
```

以下为此前阶段的历史记录，保留当时的结果与未决问题，当前结论以上述最新报告为准：

- [基础回归](docs/regression.md)：状态汇总、网页流程隔离、HTTP/SSE 集成测试与 Node 24 CI。
- [判分基线](docs/evaluation-2026-10-08.md)：12 个固定作答重复三轮，36 次符合预定区间；[运行方法](docs/evaluation.md)。
- [稳定性记录](docs/stabilization-2026-10-08.md)：补救范围、按节点实践与来源核实，当时为 187 项测试。
- [首轮微课验收](docs/course-acceptance-2026-10-08.md)：当时内容质量未通过，发现超纲和错误资料；[验收方法](docs/course-acceptance.md)。
- [内容准入记录](docs/content-quality-2026-10-08.md)：加入题目盲解、反例检查、范围审查与有界修复；[准入及旧数据说明](docs/content-quality.md)。

真人教学效果与正常使用的成本基线仍需试学积累；Harness 档案挂载继续等待官方扩展接口。

核心规则位于 `src/core/`（不依赖 Harness 与命令行，含 JSON-RPC 方法表）；`src/plugin/` 编排模型调用并以 dsh 插件挂载；`src/server/` 提供可独立测试的 HTTP/SSE 宿主。课程当前状态存 YAML，对话留在 Harness 日志；暂未实现从日志完整重建课程状态。

说明：复习答错会把已 mastered 的知识点降级，下次 `learn` 时计划指针会指回该节点（补救课）——这是设计行为，不是进度丢失。

## 环境要求

- **Node ≥ 22.19，建议 24 LTS**（Harness 依赖 `import.meta.main`，仅官方实测 22.19/24/26；Node 23 会静默失效）
- Harness 锁定 `@deepseek-ai/dsh@0.1.5-rc.2`（开发预览期，升级需显式变更）

## 快速开始

```sh
npm install
npm run serve                   # http://127.0.0.1:8788，尚未配置模型也能启动
```

打开网页右上方的“模型设置”，填写服务地址、API Key 和模型名称，保存后即可开设新课程。后续也可在页面切换渠道；已有配置会自动带入，密钥留空可沿用。命令行用户可继续使用 `.env`（从 `.env.example` 复制）：网页保存的配置优先于环境变量，环境变量优先于 `.env`。

其他命令：

```sh
npm test                        # 核心规则 + HTTP/SSE 集成测试（无需模型）
npm run eval:grading            # 校验固定判分样本；加 -- --live 才调用模型，见 docs/evaluation.md
npm run eval:content            # 校验冻结的内容错例与正确对照；真实回归见 docs/content-quality.md
npm run agent -- list           # 课程列表（零模型，含到期复习徽章）
npm run agent -- status golang  # 进度看板（知识点掌握状态/里程碑/复习到期）
npm run agent -- new golang     # 需求澄清访谈（交互）→ courses/golang/profile.yaml
npm run agent -- assess golang  # 摸底测评（自适应题库，可中断续测）→ learner-profile + mastery
npm run agent -- plan golang    # 生成/更新教学计划（跳过已掌握、依赖排序）→ plan.yaml
npm run agent -- learn golang   # 开始/继续本节课（备课→对话式讲授；/quiz 课后小测→判分→更新掌握度与计划指针；中断后重跑自动续学）
npm run agent -- review golang  # 复习到期知识点（SM-2 简化阶梯 1/3/7/14 天；答错回退一级不清队列；掌握度差节点指针留原地=补救课）
npm run agent -- review --all   # 跨课程到期汇总复习（多课程）
npm run agent -- practice-gen golang # 生成实践任务（每知识点 1 个动手任务 + 规则化测试，需模型）
npm run agent -- practice golang     # 实践任务：在 courses/<id>/sandbox/ 写代码 → 回车跑测试（零模型规则判分；通过则掌握度保底 0.8）
npm run agent -- practice-gen golang --node channels # 只为指定知识点生成任务，支持已掌握节点
npm run agent -- practice golang --node channels     # 明确选择本次要巩固的知识点
npm run agent -- exam golang [m1]    # 里程碑大考（自动选下一个可考里程碑）：客观题规则判分+主观题模型判分，通过=里程碑达成，不过=指针回退补救
npm run agent -- research golang # 联网教研：MCP 搜索+交叉验证 → 带来源知识地图（逐点保存、可中断续研）
npm run agent -- research golang --node channels # 单独教研或补查一个知识点
npm run agent -- audit [会话id]  # 课堂忠实度抽查（零模型）：计划覆盖率/引用纪律/超纲/成本 → audits/<会话>.json
npm run agent -- audit-content golang # 审查旧课程内容并保存准入；需模型，不改变学习状态
npm run agent -- "..."          # 一次性 agent 任务
```

- 网页模型设置：[使用说明](docs/model-settings.md)；保存在本机 `data/model-config.json`，后续网页和 CLI 模型流程共用；服务仅本机访问，端口可设 `TUTOR_SERVER_PORT`
- 模型接入模板：`config/settings.yaml`（由 `scripts/agent.mjs` 渲染为运行时副本）
- 成本估算单价：`config/cost.yaml`（按网关实际计费修改；讲授中每回合绿/黄/红显示，退出时显示会话累计）
- 联网教研（二期，可选）：`.env` 配置 `TUTOR_MCP_SEARCH_URL` / `TUTOR_MCP_SEARCH_TOKEN`（MCP 搜索服务）；讲授使用 [资料:n] 引用，内容在展示前独立审查，`/check` 查看准入记录与引用编号
- 会话日志：`data/dsh-home/sessions/`（JSONL 压缩存储，勿手改）
- 实践执行：目前在本机子进程运行，提供超时与输出限制；`sandbox/` 是任务工作目录，尚无操作系统级文件与网络隔离

## 相关仓库

- [learn_agent](https://github.com/xiaoxixideyu/learn_agent) — agent 学习笔记、课程与概念沉淀
