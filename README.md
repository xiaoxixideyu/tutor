# tutor · 你的学习导师

一个根据目标、作答和反馈持续选择教学策略的 agent。学员表达目标后，导师按情况选择解释、诊断、练习、独立任务、复习和阶段验收，课程结构逐步形成。

教学策略由 TutorAgent 决定；程序提供受限能力、内容核对、规则评分、证据记录、预算和可靠恢复。技能、课堂活动、能力证据、记忆状态分别建模，一次练习成绩不会直接成为“已掌握”。

在“模型设置 → 判断模型（可选）”中可以选择判断方式。默认使用大模型，也可指定同一渠道中的其他核验模型；选择 TypeSafe / Jev 后，填写独立的地址、模型与密钥即可启用快速辅助判断，并可单独测试连接。低置信度、超时或服务失败会回退大模型。教学策略、复杂正确性审核和评分反馈仍由大模型承担；关闭后无需额外服务。

## 开始使用

需要 Node ≥22.19，推荐 Node 24。

~~~sh
npm install
npm run serve
~~~

打开 http://127.0.0.1:8788，在“模型设置”填写 OpenAI 兼容服务地址、模型名称和 API Key，然后创建一个学习目标。

新目标只需一句话；每日可用时间、目标日期和已有基础可以补充。导师会从一个适合当前基础的步骤开始。课堂支持选择、数值、开放作答和代码任务，以及提示、换讲法、暂停与恢复。

## 命令行

~~~sh
npm run agent -- new "我会 Java，想掌握 Go 的并发"
npm run agent -- list
npm run agent -- learn <课程标识>
npm run agent -- status <课程标识>
npm run agent -- today --plan
npm run agent -- review <课程标识>
npm run agent -- practice <课程标识>
npm run agent -- assess <课程标识>
npm run agent -- exam <课程标识>
npm run agent -- research <课程标识>
npm run agent -- repair <课程标识>
~~~

这些命令表达用户意图，具体教学行动由导师选择。交互中 /hint 请求提示、/say 发送反馈、/continue 恢复、/pause 暂停。代码和开放题可多行输入，单独一行 . 提交；未提交草稿也会保存。

## 学习证据与恢复

- 原始题目、答案、评分标准、提示记录、题目曝光和执行结果完整保存。
- 能力评定依赖独立证据及关键验收要求；重复题或提示后的答案不冒充新的独立证据。
- 完整目标达成还需要整体范围核查，近期几个技能通过不会自动表示课程全部完成。
- 活动和已提交成绩保留；出现新的失败时增加证据，导师选择必要的补救。
- 请求回执幂等，过期题目和修改已提交答案会被拒绝。
- 状态采用版本化原子快照；模型等待和用户思考期间不占用写锁。
- 刷新、重放和查看进度不调用模型。多门课程可并行，同课程在 CLI 和网页间的当前处理互斥；查询不会打断正在运行的教学。

## 实践执行

macOS 使用操作系统沙箱限制文件与网络访问；JavaScript 使用 Node，Python 使用实际解释器，Go 编译为 WASI/wasm32 后在 Node WASI 中运行。代码任务采用标准输入输出，不提供网络、cgo 或任意 shell 命令。

参考程序在发布前也运行检查，学生程序使用完整输入输出比较并结合独立量规评阅。当前其他系统缺少隔离适配器时，导师选择开放任务，不直接以本机用户权限运行生成代码。

## 设置与数据

模型设置保存在 data/model-config.json；网页保存优先于环境变量，环境变量优先于 .env。教学和内容核验推理档位可分别配置，默认使用轻量推理。可用 TUTOR_AGENT_MODEL / TUTOR_REVIEW_MODEL / TUTOR_GRADER_MODEL 等环境配置指定同一渠道中的不同角色模型。快速辅助判断有独立连接，使用 TUTOR_JUDGMENT_* 设置；判断方式与核验模型调整在下一回合生效。

新学习数据保存在 courses/<id>/state.json，正文、原始证据及量规在内容寻址的 assets/，失败生成任务在 tasks/，未提交输入在 drafts/。模型会话在 data/sessions/，全局用量账在 data/model-usage.json。

默认整回合最多 16 次模型请求、6 个业务工具步骤；学习判断可批量原子提交，保留步骤用于教学和修复。TUTOR_SESSION_COST_LIMIT / TUTOR_DAILY_COST_LIMIT 控制估算预算，TUTOR_DAILY_REQUEST_LIMIT 限制包含未知用量的请求数。统计覆盖生成、核验、判分和内部重试；估算费用不等于实际账单。

本次重构已清空旧学习和运行数据，保留连接设置。新版本不读取旧 YAML 课程，也不提供旧 RPC / flow 接口。

## 验证

~~~sh
npm test
npm run typecheck
npm run eval:agent
npm run eval:agent -- --live --goal "学习目标" --background "已有基础"
~~~

真实模型验收使用独立目录，可通过 --work、--answer、--message、--resume 继续。工程模拟数据不会进入正常课程列表，也不能用来宣称真人已经学会。

详细架构见 [设计说明](docs/design.md)，实施方案见 [重构计划](docs/agent-refactor-plan-2026-11-20.md)，最终验证和实际限制见 [验收记录](docs/agent-refactor-acceptance-2026-11-23.md)。
