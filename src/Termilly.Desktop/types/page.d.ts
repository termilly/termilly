// What the page (wwwroot) has before its modules run, for the type checker (jsconfig.json): the scripts index.html loads from
// wwwroot/lib, and the host bridges WebView2 (Windows) and Photino (Linux) add to window.
declare const Terminal: any;
declare const FitAddon: any;
declare const ImageAddon: any;
declare const Unicode11Addon: any;
declare const hljs: any;
declare const qrcode: any;

/** WebView2's bridge to the host (Windows). */
interface HostWebView {
  postMessage(message: unknown): void;
  postMessageWithAdditionalObjects(message: unknown, objects: FileList | File[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
}
interface Window {
  chrome?: { webview?: HostWebView };
}
/** Photino's bridge to the host (Linux): strings both ways. */
interface External {
  sendMessage(text: string): void;
  receiveMessage(handler: (text: string) => void): void;
}
