type RpcHandler = (params: Record<string, unknown>) => void;

export class IpcClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, RpcHandler>();

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const loc = window.location;
      const wsUrl = `ws://${loc.host}`;
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket connection failed'));
      this.ws.onmessage = (ev) => this.onMessage(ev.data as string);
      this.ws.onclose = () => { this.ws = null; };
    });
  }

  on(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws) throw new Error('Not connected');
    const id = ++this.requestId;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 10_000);
    });
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw);
    if (msg.method && !msg.id) {
      const handler = this.handlers.get(msg.method);
      if (handler) handler(msg.params ?? {});
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    }
  }
}
