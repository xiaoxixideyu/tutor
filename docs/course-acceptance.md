# 真实模型课程验收

`scripts/eval-course.mjs` 用正式访谈、教研、摸底、计划、课堂、实践和大考运行器逐阶段验收。输入由验收者提供；它不自动把参考答案回填，也不把流程跑通当作真人已经学会。

固定范围与内容检查点见 `evals/course-acceptance.json`：Go 切片共享与独立复制、公平骰子的样本空间与补集，均限定两节 15 分钟微课。此范围可检查主要业务环节，不能外推为整门 Go 或概率课程的质量保证。

## 运行

使用 Node 24 LTS。运行前配置 `.env` 的模型与搜索服务。以下命令会调用真实模型；不加 `--live` 只显示用法。

```sh
node scripts/eval-course.mjs new go-slices --live
# 以上打印独立目录，例如 data/evals/course-ABC123，后续步骤沿用该目录。
node scripts/eval-course.mjs research go-slices --live --run data/evals/course-ABC123
node scripts/eval-course.mjs assess go-slices --live --run data/evals/course-ABC123
node scripts/eval-course.mjs plan go-slices --live --run data/evals/course-ABC123
node scripts/eval-course.mjs learn go-slices --live --run data/evals/course-ABC123
node scripts/eval-course.mjs practice-gen go-slices --live --run data/evals/course-ABC123 --node <知识点>
node scripts/eval-course.mjs practice go-slices --live --run data/evals/course-ABC123 --node <知识点>
node scripts/eval-course.mjs exam go-slices --live --run data/evals/course-ABC123 --milestone m1
node scripts/eval-course.mjs review go-slices --live --run data/evals/course-ABC123
node scripts/summarize-course-eval.mjs data/evals/course-ABC123
```

`practice`、`review`、`status` 阶段使用正式零模型 CLI；为保持验收入口一致仍需 `--live`。课堂通过 `/exit` 暂停，下一次 `learn` 续学；每个知识点和里程碑分别完成。

验收发现的真实阅卷错例单独保存在 `evals/course-grading-regressions.json`，保留原题、原参考答案及独立作答。重复评测使用同一个正式阅卷提示，不改写参考答案来制造通过：

```sh
node scripts/eval-grading.mjs --fixtures evals/course-grading-regressions.json
TUTOR_LLM_MODEL=deepseek-v4-pro node scripts/eval-grading.mjs --live --fixtures evals/course-grading-regressions.json --repeats 3 --max-tokens 4096
```

这个命令的费用单独保存在判分报告中，不自动并入课程阶段汇总。模型名称是本次网关路由标识；临时模型覆盖不改变日常配置。

## 隔离与证据

- 每门验收课使用独立课程根目录、工作目录与 Harness 会话库；现有课程不参与。
- 关闭自动会话标题与项目指令加载。模型只在教研阶段可使用搜索、抓取工具；其他阶段不提供工具。实践执行仍是本机子进程，运行生成测试前需检查命令与文件内容，尚无操作系统沙箱。
- 每阶段保存 `runner.log`、`input.txt`、`report.json`、`attempts.jsonl` 和课程快照；Harness 保存完整模型会话与工具结果。源码与角色提示的哈希用于追踪执行版本。
- 每阶段上限 8 分钟（含等待作答）、24 次业务请求，每次输出最多 8192 token。中断、错误和超时保留记录；限额是工程验收约束，不是正常学员的课程时长限制。
- 同一门课的课堂、考试、复习与实践执行依次运行，避免多个 CLI 同时改写掌握度；不同课程可以并行。实践出题只写任务文件，可与课堂并行。
- 题目先独立作答，再检查参考答案；实践至少运行未完成版本、正确实现及典型错误实现。规则判分通过只证明与该测试一致，还要检查测试本身是否覆盖任务目标。
- 到期复习可以在独立测试课程里调整日期来验证状态迁移，但须记录调整，不能称为隔日或一周后的真实保留测量。

## 成本与延迟口径

汇总按阶段合并所有模型会话，包含教研、摸底出题、规划、备课、讲授、事实核对、实践出题、大考出题及主观题判分；失败尝试有用量就计入，无用量单独列出。开始事件和错误通知不重复计费，恢复会话只统计本次新增请求。诊断探测与搜索服务费用需另计。

费用按 `config/cost.yaml` 估算，缓存输入暂按普通输入价；没有实际账单时 `actualBill` 为 `null`，不能声称已完成账单核对。

`firstChunkMs` 可能是推理或元数据；`firstTextMs` 是模型正文首块，均不是页面首字延迟。当前 runner 等整轮完成后才输出回复，因此交互体感更接近完整响应耗时。阶段耗时还包含人工操作与外部搜索等待，应与模型请求耗时分开分析。
