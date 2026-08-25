-- 管理画面(GWS認証)の管理者ロールを付与するプリンシパル(個人メール or Googleグループ)を管理する。
-- STAFF_ADMIN_EMAILS環境変数(個人メールの固定許可リスト)を廃止した代替。director@atlib.jpが
-- Google Workspaceのグループ(個人アカウントではない)だったため、グループのメンバーシップ判定を
-- Cloud Identity Groups API(src/services/groupMembershipService.ts)で行う必要がある。
-- group_resource_nameはtype='group'の場合のみ使用し、lookupGroup()の結果をキャッシュする
-- (毎ログインでlookup APIを呼ばずに済ませるため)。

CREATE TABLE admin_principals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type      TEXT NOT NULL CHECK (principal_type IN ('email', 'group')),
  value               TEXT NOT NULL,
  group_resource_name TEXT,
  added_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 初期管理者。group_resource_nameはNULLのまま投入し、アプリ側で初回参照時に解決してUPDATEする
-- (マイグレーション実行時点ではCloud Identity APIが有効化されていない可能性があるため)。
INSERT INTO admin_principals (principal_type, value, group_resource_name)
VALUES ('group', 'director@atlib.jp', NULL);
