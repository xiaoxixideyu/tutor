# tutor（导师）

一个个性化教学 agent：从需求澄清、教研、摸底、规划，到讲授、检验、复习，全程因材施教。

- **设计文档**：[docs/design.md](docs/design.md)
- **技术基座**：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（插件组装 + 会话日志）
- **设计参考**：Reasonix 的缓存优先循环、工具调用修复、成本控制；当前已实现按课组织上下文和成本估算，完整自定义循环与分级调度仍待实现
- **模型接入**：OpenAI 兼容接口（base_url + api_key + model），不绑定单一供应商
- **交互形态**：命令行 + 本地网页，单用户，可管理多门课程；网页同时运行一个教学流程

## 状态

一期单课程闭环与二期教研主链路已实现，2026-09 有 golang 真实课程回归记录。三期已具备多课程管理、间隔复习、实践任务、里程碑大考，以及看板／向导／课堂／复习／大考／实践六个网页。当前集中进行可靠性修正和教学效果验收，尚未以功能齐备代替质量验收。

2026-10-08：修正大考权重与知识点汇总、摸底续测入口、复习重复提交、网页流程隔离和停止恢复；加入无模型 HTTP/SSE 集成测试与 Node 24 持续集成配置。验证范围及待办见 [docs/regression.md](docs/regression.md)。四期已有忠实度审计，真实教学效果与完整成本基线仍待积累；Harness 档案挂载继续等待官方扩展接口。

真实模型判分已建立初步基线：两个领域 12 个固定作答重复三轮，36 次判分均符合预定区间；实测同时发现并修正失败尝试与缓存输入的用量漏算。使用方式见 [docs/evaluation.md](docs/evaluation.md)，模型通道、用量与验收局限见 [实测记录](docs/evaluation-2026-10-08.md)。

稳定性收尾（2026-10-08）：计划保存完整课程范围，重新规划后遗忘的节点仍可补救；实践可按知识点选择，已掌握节点也能生成与重复练习；教研至少要求两个不同注册域名的来源及模型核对结论，旧数据读取时会重新判定。187 项测试通过，浏览器已验证按节点生成、执行与切换实践。详见 [本轮验收记录](docs/stabilization-2026-10-08.md)。

真实微课验收（2026-10-08）：Go 与概率两门各两节课的访谈、摸底、讲授、小测、实践和考试主流程已运行，发现并修正题库生成恢复、取消后重试及题干外扣分等问题。内容质量仍未通过：概率试卷超纲，部分错误资料进入课堂，资料对照不能替代独立事实验证。证据、用量及下一步见 [课程验收结果](docs/course-acceptance-2026-10-08.md)，复现入口见 [验收方法](docs/course-acceptance.md)。

内容准入（2026-10-08）：已加入题目盲解、强断言反例检查、独立范围与正确性审查、精确分数复算及失败后的有界修复，覆盖生成、逐轮讲授与旧内容消费入口。旧课程需先取得准入回执；功能边界及迁移方法见 [内容准入说明](docs/content-quality.md)，包括失败尝试的验证结果见 [本轮记录](docs/content-quality-2026-10-08.md)。

核心规则位于 `src/core/`（不依赖 Harness 与命令行，含 JSON-RPC 方法表）；`src/plugin/` 编排模型调用并以 dsh 插件挂载；`src/server/` 提供可独立测试的 HTTP/SSE 宿主。课程当前状态存 YAML，对话留在 Harness 日志；暂未实现从日志完整重建课程状态。

说明：复习答错会把已 mastered 的知识点降级，下次 `learn` 时计划指针会指回该节点（补救课）——这是设计行为，不是进度丢失。

## 环境要求

- **Node ≥ 22.19，建议 24 LTS**（Harness 依赖 `import.meta.main`，仅官方实测 22.19/24/26；Node 23 会静默失效）
- Harness 锁定 `@deepseek-ai/dsh@0.1.5-rc.2`（开发预览期，升级需显式变更）

## 快速开始

```sh
npm install
cp .env.example .env            # 填入 base_url / api_key / model 三要素
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
npm run agent -- research golang # 联网教研（二期）：MCP 搜索+交叉验证 → 带来源知识地图（分批、可中断续研）
npm run agent -- audit [会话id]  # 课堂忠实度抽查（零模型）：计划覆盖率/引用纪律/超纲/成本 → audits/<会话>.json
npm run agent -- audit-content golang # 审查旧课程内容并保存准入；需模型，不改变学习状态
npm run serve                   # http://127.0.0.1:8788——看板、分步开课向导、课堂、复习、大考与实践（仅本机无鉴权；端口可设 TUTOR_SERVER_PORT）
npm run agent -- "..."          # 一次性 agent 任务
```

- 模型接入模板：`config/settings.yaml`（由 `scripts/agent.mjs` 渲染为运行时副本）
- 成本估算单价：`config/cost.yaml`（按网关实际计费修改；讲授中每回合绿/黄/红显示，退出时显示会话累计）
- 联网教研（二期，可选）：`.env` 配置 `TUTOR_MCP_SEARCH_URL` / `TUTOR_MCP_SEARCH_TOKEN`（MCP 搜索服务）；讲授使用 [资料:n] 引用，内容在展示前独立审查，`/check` 查看准入记录与引用编号
- 会话日志：`data/dsh-home/sessions/`（JSONL 压缩存储，勿手改）
- 实践执行：目前在本机子进程运行，提供超时与输出限制；`sandbox/` 是任务工作目录，尚无操作系统级文件与网络隔离

## 相关仓库

- [learn_agent](https://github.com/xiaoxixideyu/learn_agent) — agent 学习笔记、课程与概念沉淀
