# t3code-pi-plamo-ja

A Pi extension that displays Japanese translations of English replies using a local PLaMo 3 Translate server.

## できること

Pi（T3 Code から使う場合）で、Claude が英語で生成した返答を、ローカルの PLaMo 3 Translate で日本語表示します。`/plamo on` で有効化すると、内容は英語のまま生成され、画面上の日本語と併せて会話履歴には英語が残ります。コードブロックは訳しません。質問ダイアログは `ask_user_question` の `tool_call` 引数を訳します。

T3 Code では返答本文が日本語に置き換わって見えます。質問・選択肢も可能な範囲で日本語になります。翻訳に失敗した文章は英語表示に戻します。

## 動作の仕組み

`before_agent_start` で Claude に英語で回答するよう指示します。`text_end` の `content` をローカル翻訳し、その場で訳文に置き換えます。Pi の保存履歴を変更しないため、履歴は英語です。Markdown の fenced code block はそのまま保ちます。質問ダイアログは別経路であり、`tool_call` の `ask_user_question` 入力を訳します（選択肢 preview は変更しません）。

## 導入

Pi 1.4.0 以降、Node.js 22.19 以降を想定します。

```sh
pi install git:github.com/akitana-airtanker/t3code-pi-plamo-ja
bash ~/.pi/agent/git/github.com/akitana-airtanker/t3code-pi-plamo-ja/scripts/plamo-setup.sh --model 0.8b
```

setup は llama.cpp/モデルを準備し、macOS では LaunchAgent を登録します。Pi の設定ファイルは変更しません。Pi の再起動後に `/plamo on` を実行してください。モデルの配布は行いません。HF からダウンロードし SHA-256 を検証します。

Pi が git パッケージを保存する場所は環境や Pi の版で異なる場合があります。`pi list` で実際の保存先を確認し、そこにある `scripts/plamo-setup.sh` を実行してください。

```sh
bash /path/to/t3code-pi-plamo-ja/scripts/plamo-setup.sh --model 2b
bash /path/to/t3code-pi-plamo-ja/scripts/plamo-setup.sh --check --model 2b
```

`--model 0.8b` が既定です。モデルは `~/models/plamo/` に保存されます。Linux ではサービス登録を行わず、setup が表示する `llama-server` 起動コマンドを実行してください。対象は macOS (Apple Silicon/Intel) と Linux (llama.cpp を利用者が用意する場合) です。Windows およびその他の環境は対象外です。

### モデル利用条件

この拡張や setup はモデルを再配布しません。利用者が Hugging Face から取得する PLaMo モデルには [PLaMo Community License](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF) が適用されます。商用目的には事前の PFN 登録が必要で、利用者または関係会社の直近事業年度の収入・売上が10億円以下であることも条件です。条件を満たさない商用利用には PFN の別ライセンスが必要です。モデル等を第三者に提供する場合、ライセンスのコピーを提供して遵守させ、「Built with PLaMo」を関連ウェブサイト・UI・ブログ・製品情報・製品文書に明示し、モデルの名称にも PLaMo を含める必要があります。モデル出力を公表する場合はモデル由来の出力であることを明示してください。詳細と最新の条件はリンク先の `LICENSE/ja`、`LICENSE/en` を確認してください。

## 設定

| 環境変数 | 既定値 | 内容 |
|---|---|---|
| `PLAMO_JA` | 無効 | `1` で起動時から有効 |
| `PLAMO_JA_ENDPOINT` | `http://127.0.0.1:18080/v1` | llama.cpp OpenAI-compatible endpoint |
| `PLAMO_JA_MODEL` | 未指定 | リクエストの model 値 |
| `PLAMO_JA_FORM` | `polite` | `plain` または `polite` |
| `PLAMO_JA_TIMEOUT_MS` | `90000` | 翻訳 1 回あたりの制限時間（ミリ秒） |

`/plamo on` は翻訳を有効にし、サーバの応答も確認します。`/plamo off` は無効化、`/plamo status` は状態と endpoint を表示します。引数なしも status です。

オンとオフはスレッド（Pi のセッション）ごとに記録し、Pi が再起動しても引き継ぎます。記録はモデルには渡りません。オンのあいだは、返答が終わるたびに「PLaMo 翻訳: 有効（3か所を訳し、2.1秒）」のような通知を1行出します。オフのときは何も出しません。

## 制限

- T3 Code の表示は、Pi の `text_end` イベントをその場で書き換える文書化されていない挙動に依存します。Pi や中継側の更新で表示されなくなる可能性があります。
- 確認した組み合わせは、Pi 1.4.0 と 1.5.0、pi-claude-bridge 0.9.3（Claude の呼び出し）、T3 Code (Beta) 0.1.7 です。表示は T3 Code の画面と、T3 Code と同じ RPC の出力で確かめました。
- Pi 自身のターミナル画面（TUI）と、pi-claude-bridge 以外のプロバイダでは確かめていません。
- 0.8B は誤訳があります。機械翻訳なので重要な判断には使わないでください。翻訳品質の優位性は主張しません（評価は別途進行中）。
- コードブロックのあいだの文は、まず 1 回の依頼でまとめて訳します（文脈を保つため）。制限時間を超えるか失敗したときは、段落ごと（600 字を超える段落は行ごと）に分けて 4 件ずつ訳し直します。それでも訳せなかった部分だけ英語のまま表示します。
- 翻訳が終わるまで、Pi は次の処理を待ちます。長い応答やサーバが混んでいるときは、表示までに時間がかかります。サーバが止まっているときは英語のまま表示します。

## 謝辞

着想は [kikuchy/plamo-ja-mod](https://github.com/kikuchy/plamo-ja-mod)（Claude Code 用 mod、MIT）に由来します。PFML3 プロンプトの形は同 mod と PLaMo 3 Translate のモデルカードを参考にしました。コードは写していません。`NOTICE` に記録しています。

## ライセンス

本リポジトリのコードは MIT License（Copyright (c) 2026 akitana-airtanker）です。PLaMo のモデルと出力には別途 PLaMo Community License が適用されます。
