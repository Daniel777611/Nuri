// Choices a parent makes about themselves, shared by onboarding and profile editing.
// Labels are translation keys.

export const CONCERNS = [
  ["sleep", "睡眠"], ["food", "饮食／副食品"], ["emotion", "情绪与哭闹"],
  ["development", "发展与学习"], ["parenting", "教养方式"], ["health", "生病与健康"],
  ["childcare", "托育／幼儿园"], ["family", "家人教养观念不同"], ["unknown", "我不知道从哪开始"], ["other", "其他"],
] as const;
// NURI addresses the parent by role, so an unanswered role used to be stored
// as "mom" for everyone. Asked in onboarding rather than at signup to keep signup to
// just email and password.
export const PARENT_ROLES = [["mom", "妈妈"], ["dad", "爸爸"], ["grandparent", "祖父母／外祖父母"], ["other", "其他照顾者"]] as const;
export const HELP_PREFS = [["research", "专业研究与知识"], ["experience", "真实家长经验分享"], ["analysis", "一步一步分析原因"], ["actionable", "直接给我可执行的方法"]] as const;
export const INFO_SOURCES = [["research", "专业研究／论文"], ["expert", "医师或专家"], ["parents", "其他家长经验"], ["all", "都会参考"]] as const;
export const FREQUENCIES = [["daily", "每天一次"], ["weekly_2_3", "每周 2～3 次"], ["weekly", "每周一次"], ["on_demand", "有需要时再推播"]] as const;
