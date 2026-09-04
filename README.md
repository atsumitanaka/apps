# atsumitanaka / apps

業務・研究用の小規模ツール集です。各ツールは単一HTMLファイルまたは静的サイトとして動作します。

**ポータル:** https://atsumitanaka.github.io/apps/

---

## ツール一覧

### ポリマー組成 BigSMILES 入力ツール
**ファイル:** `polymer_smiles_tool.html`  
**URL:** https://atsumitanaka.github.io/apps/polymer_smiles_tool.html

ポリマーの繰り返し単位を BigSMILES 記法で記述し、データベース入力用 JSON を生成するツール。ポリマー種別（PPE・PI・SMA・BMI・CE・Epoxy など）を選択すると代表的な繰り返し単位の SMILES が自動入力される。結合子は `[$]`（BigSMILES 準拠）に統一。

- 複数 component・複数 element に対応
- 全 element を連結した BigSMILES 文字列を同時出力
- Reactive / Inert 分類、Homopolymer / Copolymer 等の種類を JSON に含む

---

### NIMSジュニア 勤務表ジェネレータ
**ディレクトリ:** `nims_junior_schedule/`  
**URL（管理画面）:** https://atsumitanaka.github.io/apps/nims_junior_schedule/admin/

週固定パターン＋月ごとの調整設定から勤務表を生成し CSV 出力する管理ツール。

---

### 勤務時間計算ツール
**ファイル:** `kinmu_keisan.html`  
**URL:** https://atsumitanaka.github.io/apps/kinmu_keisan.html

SRKINMUCSV 形式の勤務データを集計し、実労働時間・超過時間を計算するツール。半休（AM=3:30 / PM=4:15）に対応。

---

### サブスクリプション管理システム
**ディレクトリ:** `subscription_manager/`  
**URL:** https://atsumitanaka.github.io/apps/subscription_manager/

M365 SharePoint リスト + Power Automate を用いたサブスクリプション管理の構成手順書。請求日に自動通知メールを送信。

---

### NIMS 奨学金・制度検索
**外部リポジトリ:** https://github.com/atsumitanaka/nims-scholarship-finder  
**URL:** https://atsumitanaka.github.io/nims-scholarship-finder/

奨学金・支援制度の要項 PDF を AI（Gemini Flash Lite）で解析・検索できる GitHub Pages SPA。GitHub Actions で手動更新。

---

### 受験スケジュール
**ディレクトリ:** `exam_schedule/`  
**URL:** https://atsumitanaka.github.io/apps/exam_schedule/

筑波大学 国際マテリアルズイノベーション専攻 × NIMSジュニア研究員の併願スケジュール管理ページ。

---

## ライセンス

各ツールは個人・所属研究グループでの利用を想定した非公開ツールです。
