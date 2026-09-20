# tutor（导师）

一个个性化教学 agent：从需求澄清、教研、摸底、规划，到讲授、检验、复习，全程因材施教。

- **设计文档**：[docs/design.md](docs/design.md)
- **技术基座**：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（一切皆插件 + 会话日志唯一事实来源）
- **融合优点**：Reasonix 的缓存优先循环、工具调用修复、成本控制（实现为自定义循环插件）
- **模型接入**：OpenAI 兼容接口（base_url + api_key + model），不绑定单一供应商
- **交互形态**：命令行，单用户

## 状态

设计定稿。第一期（单课程教学闭环）与第二期（教研系统）已完成并通过 golang 真实课程端到端回归。第三期进行中：多课程并行体验、强化复习（SM-2 简化版）、前端壳一期（本地 JSON-RPC 服务 + 静态看板）、实践任务沙箱已落地；Harness 档案挂载待基座演进。四期评测起步：课堂忠实度抽查（audit：计划覆盖率/引用纪律/超纲/成本）已落地，随真实使用积累基线。

核心能力位于 `src/core/`（不依赖 Harness 与命令行，`npm test` 独立测试；JSON-RPC 方法表也在核心，壳只做传输）；`src/plugin/` 以 dsh 插件形态挂载（`config/` 模板 + `scripts/agent.mjs` 渲染）。

说明：复习答错会把已 mastered 的知识点降级，下次 `learn` 时计划指针会指回该节点（补救课）——这是设计行为，不是进度丢失。

## 环境要求

- **Node ≥ 22.19，建议 24 LTS**（Harness 依赖 `import.meta.main`，仅官方实测 22.19/24/26；Node 23 会静默失效）
- Harness 锁定 `@deepseek-ai/dsh@0.1.5-rc.1`（开发预览期，升级需显式变更）

## 快速开始

```sh
npm install
cp .env.example .env            # 填入 base_url / api_key / model 三要素
npm test                        # 核心单元测试（无需模型）
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
npm run agent -- research golang # 联网教研（二期）：MCP 搜索+交叉验证 → 带来源知识地图（分批、可中断续研）
npm run agent -- audit [会话id]  # 课堂忠实度抽查（零模型）：计划覆盖率/引用纪律/超纲/成本 → audits/<会话>.json
npm run serve                   # 前端壳：http://127.0.0.1:8788——看板 + 「开设新课程」向导（访谈→摸底→计划全自动）+ 浏览器课堂，全流程网页交互（仅本机无鉴权，勿暴露公网；端口被占可设 TUTOR_SERVER_PORT）
npm run agent -- "..."          # 一次性 agent 任务
```

- 模型接入模板：`config/settings.yaml`（由 `scripts/agent.mjs` 渲染为运行时副本）
- 成本估算单价：`config/cost.yaml`（按网关实际计费修改；讲授中每回合绿/黄/红显示，退出时显示会话累计）
- 联网教研（二期，可选）：`.env` 配置 `TUTOR_MCP_SEARCH_URL` / `TUTOR_MCP_SEARCH_TOKEN`（MCP 搜索服务）；讲授红线——事实断言须标 [资料:n]，`/check` 自动核对
- 会话日志：`data/dsh-home/sessions/`（JSONL 压缩存储，唯一事实来源，勿手改）

## 相关仓库

- [learn_agent](https://github.com/xiaoxixideyu/learn_agent) — agent 学习笔记、课程与概念沉淀
