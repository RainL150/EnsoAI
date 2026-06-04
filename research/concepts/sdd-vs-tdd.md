---
concept: SDD vs TDD
confidence: 0.86
sources_count: 10
updated: 2026-06-04
---

# SDD 和 TDD 调研笔记

## 结论先行

SDD 在当前 AI 编程语境里通常指 **Specification-Driven Development，规格驱动开发**：先把需求、约束、架构、验收标准和任务拆解写成结构化规格，再让人或 AI 按规格实现。TDD 指 **Test-Driven Development，测试驱动开发**：先写一个失败的自动化测试，再写刚好让测试通过的代码，然后重构，如此循环。

> **通俗理解**：SDD 像“先把施工图、验收标准、材料限制都定清楚，再施工”；TDD 像“每砌一小段墙，先放好量尺，砌完马上量，不合格就改”。

一句话区分：**SDD 驱动的是“做什么、为什么、边界在哪里”；TDD 驱动的是“这段代码是否以可验证的方式做对了”。**

## 术语边界

SDD 不是一个完全新的词。早期软件工程里已经有 specification-driven development，泛指用规格说明来开发软件，也和 Design by Contract、模型驱动、文档驱动等方法有关。2025 年后，随着 AI coding agent 普及，SDD 被重新包装为一种面向 AI 的工作流：规格不再只是参考文档，而是 AI 执行、生成代码、生成测试、保持上下文的主要输入。

> **通俗理解**：以前的规格更像“需求文档给程序员看”；现在 AI 语境下的规格更像“给机器执行的任务合同”。区别不在于有没有文档，而在于规格是否持续参与实现、验证和变更。

TDD 的边界更稳定。Agile Alliance 和 Martin Fowler 都把它描述为测试、编码、重构交织的小循环，常被概括为 `Red -> Green -> Refactor`。测试在 TDD 中不是事后补充的质量检查，而是开发顺序和接口设计的约束。

> **通俗理解**：TDD 的测试不是“写完代码后验尸”，而是“开工前先定义这一小步怎样才算对”。

## SDD 的核心机制

典型 SDD 工作流可以概括为：

1. `Constitution / Principles`：项目长期原则，比如技术栈、代码风格、安全边界、测试要求。
2. `Specify`：写清楚要解决什么问题、用户故事、验收标准、约束和非目标。
3. `Clarify`：专门找歧义，比如边界条件、空状态、错误处理、权限、性能要求。
4. `Plan`：把需求翻译成技术方案，包括架构、数据模型、API 合约、依赖和风险。
5. `Tasks`：拆成小任务，按依赖排序，每个任务尽量可独立验证。
6. `Implement & Iterate`：人或 AI 按任务实现，测试和人工 review 对照规格验证；变更时先更新规格。

> **举个例子**：你要做“导出聊天记录”。SDD 不会直接让 AI 写代码，而是先要求规格回答：导出哪些字段？支持 Markdown 还是 JSON？大文件怎么办？敏感 token 是否脱敏？失败后是否可重试？这些问题回答完，再生成技术计划和任务列表。

SDD 在 AI 开发里有一个现实动机：AI 很擅长生成代码，但对模糊意图、长期上下文、隐含约束很敏感。规格把这些约束显式化，减少“AI 看起来完成了，但其实做错了”的概率。

> **通俗理解**：AI 像执行力很强但容易误会意思的外包工程师。SDD 的价值是把“你应该懂的”写成“你必须遵守的”。

## TDD 的核心机制

TDD 的基本循环是：

1. 写一个描述下一个行为的小测试。
2. 运行测试，确认失败，因为功能还不存在或行为还不对。
3. 写最少的生产代码让测试通过。
4. 重构测试和生产代码，保持结构清晰。
5. 重复，逐步累积回归测试。

> **举个例子**：你要写 `sum([1, 2])`。先写测试断言结果应为 `3`，测试失败；然后写最简单实现让它通过；再添加空数组、负数、溢出等测试。每个测试都迫使实现向正确行为靠近。

Martin Fowler 还强调，`Red -> Green -> Refactor` 之前通常要先列一个测试清单，然后选择最能推动设计前进的测试。也就是说，TDD 不是机械地堆测试，而是用测试顺序引导接口和设计。

> **通俗理解**：TDD 的高手不是“写很多测试”的人，而是会选“下一颗最合适的钉子”的人。选错测试粒度，TDD 会变慢、变脆、甚至反过来绑架设计。

## 对比

| 维度 | SDD | TDD |
|---|---|---|
| 驱动对象 | 规格、需求、约束、计划、任务 | 自动化测试，尤其是小粒度行为测试 |
| 主要问题 | 意图不清、AI 误解、跨角色对齐、复杂功能失控 | 代码正确性、接口设计、回归安全、小步反馈 |
| 典型节奏 | 先规格，再计划，再任务，再实现 | 失败测试 -> 通过代码 -> 重构 |
| 粒度 | 功能、模块、系统、跨团队协作 | 函数、类、模块、小行为 |
| 产物 | `spec.md`、`plan.md`、`tasks.md`、验收标准、架构约束 | 测试代码、生产代码、重构后的设计 |
| 与 AI 的关系 | 很适合 AI agent，把规格当上下文和执行合同 | 也适合 AI，但更偏验证与回归护栏 |
| 主要收益 | 降低歧义、提高可审查性、让 AI 输出更可控 | 快速反馈、减少回归、改善接口设计 |
| 主要成本 | 前期写规格成本；规格容易过期；小任务可能显得重 | 测试维护成本；不适合所有代码；粒度不好会拖慢 |
| 失败模式 | 规格写得很漂亮但没人维护；规格错误导致系统性错误 | 只追求覆盖率；测试过细绑定实现；忽略重构 |

> **一句话总结**：SDD 更像产品、架构和 AI 执行层的“上游合同”；TDD 更像代码层面的“快速反馈仪表盘”。复杂功能适合先 SDD 定方向，再 TDD 保证每一步落地正确。

## 二者可以怎么组合

推荐组合方式：

1. 用 SDD 写清楚功能规格、边界、验收标准和技术计划。
2. 从规格中提取 acceptance criteria，转成测试清单。
3. 对每个实现任务使用 TDD 小循环。
4. PR review 时同时检查：代码是否满足测试，测试是否覆盖规格，规格是否需要更新。

> **实际案例**：做“AI Agent 设置页”。SDD 负责定义模型选择、额度限制、失败状态、兼容性和 UI 约束；TDD 负责验证模型配置解析、额度计算、异常分支、状态迁移。前者防止“做偏”，后者防止“做坏”。

一个实用公式：

```text
SDD = intent + constraints + plan + acceptance criteria
TDD = failing check + minimal implementation + refactoring
SDD + TDD = clear direction + tight feedback
```

> **通俗理解**：SDD 解决“往哪走”，TDD 解决“每一步有没有踩稳”。只做 SDD，可能计划很好但代码不稳；只做 TDD，可能代码很稳但方向不对。

## 什么时候用 SDD

适合：

- 需求有多种解释，容易做偏。
- AI agent 参与较多，需要持续上下文。
- 跨模块、跨团队、跨角色协作。
- 涉及安全、权限、数据迁移、兼容性、性能等约束。
- 中大型功能，需要先评审方案。

不太适合：

- 一次性脚本、小修小补、探索性 spike。
- 需求本身还在快速试错，写详细规格的成本高于收益。
- 团队没有维护规格的习惯，规格会快速变成过期文档。

> **举个例子**：改一个按钮颜色不值得写 SDD；重做设置系统、导入导出、账号权限、支付流程，就很适合 SDD。

## 什么时候用 TDD

适合：

- 纯逻辑、状态机、解析器、计算规则、权限判断。
- bug 修复，先写一个复现 bug 的失败测试。
- API、服务、工具函数、可稳定断言的行为。
- 长期维护的核心模块，需要回归安全网。

不太适合：

- 快速视觉探索。
- 很难自动断言的原型交互。
- 测试成本远高于变更风险的临时代码。
- 需求尚未清楚到能写稳定行为断言。

> **举个例子**：文件树缩进算法、Git 状态解析、IPC 参数校验很适合 TDD；探索一个全新动效时，先写 TDD 往往会拖慢验证速度。

## 常见误区

误区 1：SDD 等于瀑布。

更准确的说法是：SDD 强调先澄清意图，但规格本身可以迭代。好的 SDD 是 living spec，变更从规格开始，而不是代码偷偷偏离规格。

> **通俗理解**：瀑布的问题是“文档冻结后不许变”；SDD 的关键是“文档可以变，但代码要跟着它变，而且变更要被看见”。

误区 2：TDD 等于写很多测试。

TDD 的重点不是数量，而是测试先行、小步反馈、重构。只补大量事后测试不等于 TDD。

> **通俗理解**：体检报告再厚也不代表你每天训练科学。TDD 是训练方法，不只是测试资产。

误区 3：有 SDD 就不需要 TDD。

SDD 可以产出验收标准和测试方向，但不能替代代码级反馈。规格说“权限校验正确”不等于每个分支真的正确。

> **通俗理解**：施工图不能替代水平仪。图纸告诉你怎么建，水平仪告诉你现在有没有歪。

误区 4：有 TDD 就不需要 SDD。

TDD 擅长局部行为，但如果需求本身方向错了，测试越多可能只是更稳定地实现错误目标。

> **通俗理解**：你可以非常严谨地走错路。每一步都正确，不代表目的地正确。

## 对 EnsoAI 这类项目的建议

EnsoAI 是 Electron + React + TypeScript 项目，涉及主进程 IPC、preload bridge、Zustand store、终端、Git worktree、AI agent 集成。更适合采用“轻量 SDD + 局部 TDD”的组合。

建议落地方式：

1. 大功能先写 `docs/plans/YYYY-MM-DD-feature-design.md`，包含目标、非目标、IPC 合约、状态流、UI 约束、失败状态和验证方式。
2. 复杂实现拆成 `plan.md` 风格任务，任务粒度控制在一个可 review 的提交内。
3. 对共享逻辑、解析器、IPC 参数校验、Git 状态处理补测试。
4. UI 变更用设计文档和人工/截图验证补足，避免为了 TDD 强行测试样式细节。
5. AI agent 执行前读取设计文档、`docs/design-system.md` 和相关源码，执行后更新规格中的决策和偏差。

> **实际案例**：如果要做“多 AI Agent 会话恢复”，先 SDD 写清楚会话状态机、持久化结构、失败恢复、IPC 事件、UI 空状态；再用 TDD 测状态机和日志解析。这样 AI 不容易误改架构，人 review 也有明确依据。

## 来源

| 来源 | 可信度 | 关键用途 | 链接 |
|---|---|---|---|
| GitHub Spec Kit 文档 | 🟢 高 | 当前 AI 语境下 SDD 定义、核心流程 `Spec -> Plan -> Tasks -> Implement` | https://github.github.com/spec-kit/ |
| GitHub spec-kit 仓库 README | 🟢 高 | SDD 把规格视为可执行/生成实现的中心工件 | https://github.com/github/spec-kit |
| GitHub spec-kit `spec-driven.md` | 🟢 高 | SDD 哲学：规格作为 source of truth，代码作为表达 | https://github.com/github/spec-kit/blob/main/spec-driven.md |
| arXiv: Spec-Driven Development: From Code to Contract in the Age of AI Coding Assistants | 🟢 高 | SDD 研究性概述，提出 spec-first、spec-anchored、spec-as-source 层次 | https://arxiv.org/abs/2602.00180 |
| SpecDD 官方站 | 🟡 中 | `.sdd` 文件、与 AI agent 共享意图和边界的工具化实践 | https://specdd.ai/ |
| specdriven.ai | 🟡 中 | 现代 SDD 工作流、clarify/plan/tasks、人类编排等模式 | https://specdriven.ai/ |
| Wikipedia: Specification-driven development | 🟡 中 | 说明 SDD 不是 2025 后才出现的新词 | https://en.wikipedia.org/wiki/Specification-driven_development |
| Agile Alliance: TDD | 🟢 高 | TDD 定义、规则、收益、陷阱、历史 | https://agilealliance.org/glossary/tdd/ |
| Martin Fowler: Test Driven Development | 🟢 高 | TDD 三步循环、测试清单、接口设计价值 | https://martinfowler.com/bliki/TestDrivenDevelopment.html |
| arXiv: A Dissection of the TDD Process | 🟢 高 | TDD 实证研究，指出收益可能与小步粒度和稳定节奏更相关 | https://arxiv.org/abs/1611.05994 |

## 置信度报告

| 维度 | 状态 | 说明 |
|---|---|---|
| TDD 定义 | ✓ 一致 | Agile Alliance、Fowler 等来源基本一致：测试先行、小步实现、重构 |
| TDD 收益 | ⚠️ 部分确定 | 实践者普遍认可质量和设计收益，但实证研究对“测试先写”本身的独立贡献更谨慎 |
| SDD 定义 | ✓ 基本一致 | 多个 2025-2026 来源都强调规格作为 source of truth，尤其服务 AI coding agent |
| SDD 历史 | ✓ 一致 | 早期已有 specification-driven development；AI 时代是重新流行和工具化 |
| SDD 效果 | ⚠️ 中等置信 | 工具和方法论增长很快，但严肃实证研究少于 TDD，目前更多来自工具文档、实践文章和新论文 |
| SDD vs TDD 关系 | ✓ 高置信 | 两者不是替代关系：SDD 管上游意图与计划，TDD 管代码级反馈与设计 |

## 最短实践建议

对真实项目，不要把 SDD 和 TDD 当宗教。采用这个决策规则：

```text
需求不清、AI 容易做偏、影响范围大 -> 先 SDD
行为可断言、逻辑复杂、回归风险高 -> 用 TDD
两者都满足 -> SDD 定规格，TDD 做实现闭环
两者都不满足 -> 轻量说明 + 快速人工验证即可
```

> **通俗理解**：SDD 和 TDD 都是降低返工的工具。返工风险越高，越值得前置规格和测试；风险很低时，仪式感不要超过问题本身。
