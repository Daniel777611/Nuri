# 数据库迁移流程

两个 Supabase 项目（组织 OrdashTeches）：

| 项目 | ref | 用途 |
| --- | --- | --- |
| Nuri-Testing | `kyxnnrmyzmdutqylsxpw` | 测试库。新迁移先上这里 |
| Nuri-User | `cxxidflulsdmcnazrouw` | 正式库，线上用户的数据 |

`supabase/migrations/` 里的每个文件就是一次迁移，文件名前面的时间戳是版本号。
每个库里的 `supabase_migrations.schema_migrations` 记着它跑过哪些版本，`supabase db push`
只会跑没记过的那些，并且跑完自动记上。**所以迁移只用 CLI 上，不要在 SQL Editor 里手动跑**，
手动跑的不会被记下来，下次 `db push` 会再跑一遍。

## 第一次在一台电脑上用

```bash
brew install supabase/tap/supabase   # 或者不装，用 npx supabase@latest 代替下面的 supabase
supabase login                       # 浏览器里授权一次
```

`db push` 要数据库密码：Supabase 后台 → Project Settings → Database。可以每次输入，
也可以临时 `export SUPABASE_DB_PASSWORD=...`，不要写进仓库。

## 加一个新迁移

1. `supabase migration new <简短英文名>`，在生成的文件里写 SQL。
   - 版本号不能和已有文件重复（两个文件同一个时间戳，CLI 会报错）。
   - 尽量写成可以重复执行的（`if not exists` / `if exists`）。
2. 先推到 **testing**：

   ```bash
   supabase link --project-ref kyxnnrmyzmdutqylsxpw
   supabase db push --dry-run   # 看会跑哪些文件
   supabase db push
   ```

3. 用连 testing 的后端验证功能。
4. 分支合进 `main`、准备上线时，再推到 **正式库**，并且要在部署依赖它的代码**之前**：

   ```bash
   supabase link --project-ref cxxidflulsdmcnazrouw
   supabase db push --dry-run
   supabase db push
   ```

5. `supabase migration list` 可以对照本地文件和库里的记录。

## 规矩

- 已经在任何一个库上跑过的迁移文件不要再改，要改就加一个新的迁移。
- 实在不得不在 SQL Editor 里手动改了结构（比如线上紧急修复），事后马上把同样的 SQL 补成迁移文件，
  并在改过的库上执行 `supabase migration repair --status applied <版本号>` 记上，不然两边又对不上。
- 删数据、删表的迁移，`--dry-run` 之后先给负责人看过再推正式库。
- 在 SQL Editor 里保存的查询不要留成 "Untitled query"：按对应的迁移文件命名
  （例如 `20261122010000_fix_reviewers_and_history_sync.sql`），描述里写清在哪个项目、哪天跑过、能不能再跑。
  两个项目里同一件事用同一个名字，方便对照和移植。

## 现状（2026-11-22 整理）

- 两个库的表结构和 `main` 的迁移一致，历史记录已补齐到 `20261122010000_fix_reviewers`。
  在这之前大部分迁移是在 SQL Editor 里手动跑的，所以 9 月以后的记录是补登记的。
- testing 上还多了 `Testing-Backend-Alpha` 分支的两个 Apple 登录迁移
  （`20261114032218`、`20261114034928`），`main` 里还没有这两个文件。在 Alpha 合进 `main` 之前，
  从不含这两个文件的分支往 testing `db push` 会被 CLI 拒绝（库里有本地没有的版本）。
  往 testing 推之前，先把 `main` 合进 Alpha，从 Alpha 推；或者等 Alpha 合进 `main`。
- `20261105010000_chat_message_reports.sql` 改名为 `20261105005000_…`，因为它和
  `20261105010000_community.sql` 用了同一个版本号。
