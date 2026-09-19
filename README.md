# tutor（导师）

一个个性化教学 agent：从需求澄清、教研、摸底、规划，到讲授、检验、复习，全程因材施教。

- **设计文档**：[docs/design.md](docs/design.md)
- **技术基座**：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（一切皆插件 + 会话日志唯一事实来源）
- **融合优点**：Reasonix 的缓存优先循环、工具调用修复、成本控制（实现为自定义循环插件）
- **模型接入**：OpenAI 兼容接口（base_url + api_key + model），不绑定单一供应商
- **交互形态**：命令行，单用户

## 状态

设计定稿。第一期（单课程教学闭环）10 项任务全部完成，验收标准逐项通过。第二期（教研系统）主体完成：联网教研（MCP 搜索 + 交叉验证 → 带来源知识地图）、备课资料注入、讲授引用红线、/check 事实核对、URL 存活门已落地，待真实课程端到端回归后收尾。

核心能力位于 `src/core/`（不依赖 Harness 与命令行，`npm test` 独立测试）；`src/plugin/` 以 dsh 插件形态挂载（`config/` 模板 + `scripts/agent.mjs` 渲染）。

## 环境要求

- **Node ≥ 22.19，建议 24 LTS**（Harness 依赖 `import.meta.main`，仅官方实测 22.19/24/26；Node 23 会静默失效）
- Harness 锁定 `@deepseek-ai/dsh@0.1.5-rc.1`（开发预览期，升级需显式变更）

## 快速开始

```sh
npm install
cp .env.example .env            # 填入 base_url / api_key / model 三要素
npm test                        # 核心单元测试（无需模型）
npm run agent -- list           # 课程列表（零模型）
npm run agent -- status golang  # 进度看板（知识点掌握状态/里程碑/复习到期）
npm run agent -- new golang     # 需求澄清访谈（交互）→ courses/golang/profile.yaml
npm run agent -- assess golang  # 摸底测评（自适应题库，可中断续测）→ learner-profile + mastery
npm run agent -- plan golang    # 生成/更新教学计划（跳过已掌握、依赖排序）→ plan.yaml
npm run agent -- learn golang   # 开始/继续本节课（备课→对话式讲授；/quiz 课后小测→判分→更新掌握度与计划指针；中断后重跑自动续学）
npm run agent -- review golang  # 复习到期知识点（1/3/7/14 天阶梯；掌握度差节点指针留原地=补救课）
npm run agent -- research golang # 联网教研（二期）：MCP 搜索+交叉验证 → 带来源知识地图（分批、可中断续研）
npm run agent -- "..."          # 一次性 agent 任务
```

- 模型接入模板：`config/settings.yaml`（由 `scripts/agent.mjs` 渲染为运行时副本）
- 成本估算单价：`config/cost.yaml`（按网关实际计费修改；讲授中每回合绿/黄/红显示，退出时显示会话累计）
- 联网教研（二期，可选）：`.env` 配置 `TUTOR_MCP_SEARCH_URL` / `TUTOR_MCP_SEARCH_TOKEN`（MCP 搜索服务）；讲授红线——事实断言须标 [资料:n]，`/check` 自动核对
- 会话日志：`data/dsh-home/sessions/`（JSONL 压缩存储，唯一事实来源，勿手改）

## 相关仓库

- [learn_agent](https://github.com/xiaoxixideyu/learn_agent) — agent 学习笔记、课程与概念沉淀
