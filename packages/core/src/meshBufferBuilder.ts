export class Float32Writer {
  private data: Float32Array;
  length = 0;

  constructor(capacity: number) {
    this.data = new Float32Array(Math.max(1, capacity));
  }

  private reserve(extra: number) {
    const need = this.length + extra;
    if (need <= this.data.length) return;
    let next = this.data.length;
    while (next < need) next *= 2;
    const grown = new Float32Array(next);
    grown.set(this.data);
    this.data = grown;
  }

  push2(a: number, b: number) {
    this.reserve(2);
    const i = this.length;
    this.data[i] = a;
    this.data[i + 1] = b;
    this.length = i + 2;
  }

  push3(a: number, b: number, c: number) {
    this.reserve(3);
    const i = this.length;
    this.data[i] = a;
    this.data[i + 1] = b;
    this.data[i + 2] = c;
    this.length = i + 3;
  }

  push4(a: number, b: number, c: number, d: number) {
    this.reserve(4);
    const i = this.length;
    this.data[i] = a;
    this.data[i + 1] = b;
    this.data[i + 2] = c;
    this.data[i + 3] = d;
    this.length = i + 4;
  }

  toArray(): Float32Array {
    return this.data.slice(0, this.length);
  }

  view(): Float32Array {
    return this.data.subarray(0, this.length);
  }
}

export class Uint32Writer {
  private data: Uint32Array;
  length = 0;

  constructor(capacity: number) {
    this.data = new Uint32Array(Math.max(1, capacity));
  }

  private reserve(extra: number) {
    const need = this.length + extra;
    if (need <= this.data.length) return;
    let next = this.data.length;
    while (next < need) next *= 2;
    const grown = new Uint32Array(next);
    grown.set(this.data);
    this.data = grown;
  }

  push6(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.reserve(6);
    const i = this.length;
    this.data[i] = a;
    this.data[i + 1] = b;
    this.data[i + 2] = c;
    this.data[i + 3] = d;
    this.data[i + 4] = e;
    this.data[i + 5] = f;
    this.length = i + 6;
  }

  toArray(): Uint32Array {
    return this.data.slice(0, this.length);
  }

  view(): Uint32Array {
    return this.data.subarray(0, this.length);
  }
}
