/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Task prompts for the live evaluation. Each prompt states the task in the
 * user's words, then a harness contract: the element IDs the checks drive and
 * read. The contract makes generated views measurable without guessing their
 * structure. It also mentions the interactive view, so it overstates how often
 * a model would choose a view unprompted; the report records whether the
 * model called the tool as its own column.
 */

const CONTRACT_PREAMBLE =
  'Harness contract (an automated acceptance check reads this view): use exactly these element IDs.';

export const BILL_SPLITTER_PROMPT = [
  '我们 6 个人聚餐，菜品合计 900 元，有一张 60 元的优惠券，服务费按优惠后金额的 10% 收。',
  '帮我做一个可以直接在对话里调整的分账工具：能改菜品合计、人数、优惠金额和服务费比例，',
  '马上看到总额、每个人应付多少（精确到分，分加起来必须等于总额，多出来的分给排在前面的人）和一个分摊图。',
  '非法输入要提示。要能一键复制当前的分账结果，也要能一键恢复默认值。',
  '',
  CONTRACT_PREAMBLE,
  'Inputs: subtotal (CNY), people, discount (CNY), service-rate (percent).',
  "Outputs: total (the total amount), shares (a container with one element per person, each showing that person's amount),",
  'chart (the allocation chart), error (validation message, empty when valid).',
  'Buttons: reset, copy.',
].join('\n');

export const CHECKLIST_PROMPT = [
  '帮我做一个会议清单，我想在对话里直接用：能添加、编辑、勾选、删除条目，能按全部/未完成/已完成筛选，',
  '能多次撤销，清单为空时要有提示。我刷新页面或者之后回到这个对话时，进度要还在。',
  '',
  CONTRACT_PREAMBLE,
  'Inputs: new-item (text), filter (select with values all, open, done).',
  'Buttons: add, undo.',
  'Each item N (starting at 1) has item-N-check (checkbox), item-N-text (its text) and item-N-delete (button).',
  'Output: empty (the empty-state message).',
].join('\n');

export const ACTIVITY_FORM_PROMPT = [
  '我们团队想组织一次活动。给我一个表单，可以选活动类型（徒步、保龄球、密室逃脱）、日期、人数、人均预算，再写点备注。',
  '我调整的时候不要发消息给你；我确定之后再把当前填写的所有值发给你，你根据这些值给我建议。',
  '不要真的预订、付款或者通知任何人。',
  '',
  CONTRACT_PREAMBLE,
  'Inputs: activity (select with values hiking, bowling, escape-room), date (text, YYYY-MM-DD), participants, budget (CNY per person), notes (textarea).',
].join('\n');

export const COMPARATOR_PROMPT = [
  '帮我比较三个订阅套餐：基础版每人每月 39 元，专业版 69 元，团队版 99 元；按年付费套餐价打八折。',
  '做一个可以在对话里调的对比器：能改人数、按月/按年付费、选一个套餐；',
  '要把"折合每月"和"实际每期要付的钱"分开显示，别把年付的月均当成实际付款。',
  '',
  CONTRACT_PREAMBLE,
  'Inputs: seats; billing radios billing-monthly and billing-annual; plan radios plan-basic, plan-pro and plan-team.',
  'Outputs for each plan P in basic, pro, team: P-monthly (monthly equivalent) and P-payment (actual payment per billing period).',
  'Button: export.',
].join('\n');

export const COMPARATOR_SUPPORT_PROMPT = [
  '再加一个技术支持服务：每人每月 12 元，不参与年付折扣。保留我现在的人数、付费方式和套餐选择，',
  '加一个导出当前结果为 CSV 的功能。',
  '',
  CONTRACT_PREAMBLE,
  'Keep the earlier IDs, add support (checkbox, checked) and keep the export button.',
].join('\n');

export const COMPARATOR_RESET_PROMPT =
  '把对比器恢复成你第一次给我的初始设置，不加技术支持。保持同样的元素 ID，保留导出功能。';
