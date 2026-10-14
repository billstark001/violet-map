// #region TypedArrayWriter

type TypedArray = Float32Array | Uint32Array | Uint16Array | Uint8Array;

class TypedArrayWriter<T extends TypedArray> {
  private data: T;
  private create: (capacity: number) => T;
  length = 0;

  constructor(create: (capacity: number) => T, capacity: number) {
    this.create = create;
    this.data = create(Math.max(1, capacity));
  }

  private reserve(extra: number) {
    const need = this.length + extra;
    if (need <= this.data.length) return;
    let next = this.data.length;
    while (next < need) next *= 2;
    const grown = this.create(next);
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

  push1(a: number) {
    this.reserve(1);
    this.data[this.length++] = a;
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

  toArray(): T {
    return this.data.slice(0, this.length) as T;
  }

  view(): T {
    return this.data.subarray(0, this.length) as T;
  }
}

const float32Create = (capacity: number) => new Float32Array(capacity);
const uint32Create = (capacity: number) => new Uint32Array(capacity);
const uint16Create = (capacity: number) => new Uint16Array(capacity);
const uint8Create = (capacity: number) => new Uint8Array(capacity);

export class Float32Writer extends TypedArrayWriter<Float32Array> {
  constructor(capacity: number) {
    super(float32Create, capacity);
  }
}

export class Uint32Writer extends TypedArrayWriter<Uint32Array> {
  constructor(capacity: number) {
    super(uint32Create, capacity);
  }
}

export class Uint16Writer extends TypedArrayWriter<Uint16Array> {
  constructor(capacity: number) {
    super(uint16Create, capacity);
  }
}

export class Uint8Writer extends TypedArrayWriter<Uint8Array> {
  constructor(capacity: number) {
    super(uint8Create, capacity);
  }
}

// #endregion TypedArrayWriter
