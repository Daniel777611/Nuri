-- One conditional style rule: what to leave a parent with after a mealtime
-- blow-up, once nobody is at risk any more.
--
-- Round three, D20 (76.50, REVIEW). The same-night containment was good —
-- 「今晚你只要守住一句：『你可以后悔，但饭结束了。』」 — and then it stopped
-- there. No setup for the next meal, no repair line for after the parent's own
-- anger, and nothing saying when this stops being an ordinary phase.
--
-- Deliberately here and not in `register.py`. That table reaches every turn, so
-- a four-part mealtime protocol sitting in it would be read on a sleep question
-- and a daycare question too — which is exactly the "every reply arrives visibly
-- assembled" failure the weighted register was built to undo. `applies_when`
-- gives it a condition; the register has no way to express one.
--
-- Not an exemplar either: that corpus is entirely 语言发展, selection never
-- crosses topics, and adding a mealtime domain means adding zh and en pairs plus
-- a new gate in `topic_of` — a bigger change than this earns.
--
-- `topics` matches as a substring against the router's `topic`, a 4–10 character
-- Chinese noun phrase, which is why these entries are short.

insert into public.nuri_style_rules
  (id, rule, category, source_note, created_by, mode, priority, applies_when)
values
  ('style-mealtime-repair-01',
   '用餐冲突已经稳住、当下没有安全风险之后，再给下一餐的小流程，不要继续解释今晚。'
   '四件事各一句：饭结束前先预告一次（「还有两口就收了」）；'
   '收了以后给一个固定的、家长先选好的替代（例如一杯奶），哭的时候不重开、不加菜、不谈条件；'
   '家长自己发过火就补一句修复的话（「刚才妈妈太大声了，不是你的错」），修复的是关系不是规矩；'
   '最后说清楚什么情况该找儿科——连着几餐几乎不吃、体重掉、或吞咽会呛，'
   '而不是「再观察看看」。'
   '这一套是给下一餐的，不要在家长还在气头上的那一轮讲完。',
   'strategy',
   '2026-09-01 第三轮 D20：当晚安抚有效，但缺可重复的下一餐流程、修复话与就医触发点',
   'eval:round-03',
   'advisory',
   38,
   '{"topics": ["吃饭", "用餐", "进食", "挑食", "喂"]}'::jsonb);
