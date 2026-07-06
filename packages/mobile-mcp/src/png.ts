export interface PngDimensions {
	width: number;
	height: number;
}

export class PNG {
	public constructor(private readonly buffer: Buffer) {
	}

	public getDimensions(): PngDimensions {
		const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
		if (!this.buffer.subarray(0, 8).equals(pngSignature)) {
			throw new Error("Not a valid PNG file");
		}

		const width = this.buffer.readUInt32BE(16);
		const height = this.buffer.readUInt32BE(20);
		return { width, height };
	}
}
