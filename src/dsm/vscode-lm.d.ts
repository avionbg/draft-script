// Type stubs for vscode.lm API introduced in VS Code 1.90.
// These supplement @types/vscode 1.85 until the package can be upgraded.

import * as vscode from 'vscode';

declare module 'vscode' {
  interface LanguageModelChatResponse {
    text: AsyncIterable<string>;
  }

  interface LanguageModelChat {
    readonly id:      string;
    readonly name:    string;
    readonly vendor:  string;
    readonly family:  string;
    readonly version: string;
    sendRequest(
      messages: LanguageModelChatMessage[],
      options: object,
      token: CancellationToken
    ): Thenable<LanguageModelChatResponse>;
  }

  namespace lm {
    function selectChatModels(selector?: { vendor?: string; family?: string; id?: string }): Thenable<LanguageModelChat[]>;
  }

  namespace LanguageModelChatMessage {
    function User(content: string): LanguageModelChatMessage;
    function Assistant(content: string): LanguageModelChatMessage;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface LanguageModelChatMessage {}
}
