// 任务模块共享元数据：紫色主题、类型、鼓励语、评价选项
export type TaskItem = {
  id: string;
  title: string;
  task_type: "interaction" | "observation" | "care" | "selfcare" | string;
  is_recurring: boolean;
  total_count: number;
  completed_count: number;
  frequency_label: string;
  due_date: string | null;
  completed_at: string | null;
  is_favorited: boolean;
  last_rating: string | null;
  backfilled: boolean;
  description: string;
  steps: string[];
  source: string;
  created_at: string;
};

// 任务模块专属配色（复刻设计稿）
export const taskColors = {
  primary: "#6B5CE7",
  primaryLight: "#EEECFD",
  overdue: "#FF3B30",
  overdueBg: "#FFF0EF",
  completedBg: "#F3F1FD",
  bg: "#F5F5F7",
  text: "#1A1A1A",
  textSecondary: "#8A8A8E",
  card: "#FFFFFF",
  track: "#ECECEE",
};

// 类型：label 用于 filter/pill，prefix 用于任务名前缀（如 "亲子：xxx"）
export const TASK_TYPES: Record<string, { label: string; prefix: string }> = {
  interaction: { label: "亲子互动", prefix: "亲子" },
  observation: { label: "发展观察", prefix: "观察" },
  care: { label: "照顾陪伴", prefix: "照顾" },
  selfcare: { label: "自我照顾", prefix: "自我" },
};

export const taskTypeMeta = (t: string) => TASK_TYPES[t] || TASK_TYPES.interaction;

// filter 横向滚动条选项（IA：全部/亲子互动/发展观察/照顾陪伴）
export const FILTER_TYPES = ["interaction", "observation", "care"];

// 打卡鼓励语（按任务类型）
export const ENCOURAGEMENTS: Record<string, string> = {
  interaction: "你陪伴的每一分钟，宝宝都记得",
  observation: "细心观察是最好的礼物，你做到了",
  care: "又一天顺利搞定，你真的很厉害",
  selfcare: "照顾好自己，才能照顾好宝宝",
};

export const RATINGS = [
  { key: "bad", emoji: "😣", label: "有待改进" },
  { key: "ok", emoji: "😐", label: "还不错" },
  { key: "great", emoji: "😊", label: "非常棒！" },
];

// "2026-07-10" / ISO datetime → "7月8号" 样式或 "07 / 06" 样式
export function formatCNDate(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s.length <= 10 ? s + "T00:00:00" : s);
  if (isNaN(d.getTime())) return "—";
  return `${d.getMonth() + 1}月${d.getDate()}号`;
}

export function formatSlashDate(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s.length <= 10 ? s + "T00:00:00" : s);
  if (isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm} / ${dd}`;
}

export function isOverdue(t: TaskItem): boolean {
  if (t.completed_at || !t.due_date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(t.due_date + "T00:00:00");
  return due.getTime() < today.getTime();
}

export function progressRatio(t: TaskItem): number {
  if (t.completed_at) return 1;
  if (!t.is_recurring) return 0; // 一次性任务：打卡前空，打卡后满格
  if (t.total_count <= 0) return 0;
  return Math.min(1, t.completed_count / t.total_count);
}
