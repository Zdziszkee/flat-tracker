import type { ExpressionSpecification } from "mapbox-gl";

import { SOURCE_COLORS } from "#/lib/sources";

/** Mapbox match expression coloring each point by its source. */
export function sourceColorExpr(): ExpressionSpecification {
	const pairs: string[] = [];
	for (const [src, color] of Object.entries(SOURCE_COLORS)) {
		pairs.push(src, color);
	}
	return [
		"match",
		["get", "source"],
		...pairs,
		"#94a3b8",
	] as ExpressionSpecification;
}

/** Draw the court-auction diamond marker as raw pixels (SVG loadImage is flaky). */
export function makeKomornikIcon(): ImageData {
	const size = 28;
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (ctx) {
		// Crimson keeps the diamond distinct from every source circle
		// (domiporta purple, airbnb red, olx orange).
		ctx.fillStyle = "#be123c";
		ctx.strokeStyle = "#ffffff";
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(size / 2, 2);
		ctx.lineTo(size - 2, size / 2);
		ctx.lineTo(size / 2, size - 2);
		ctx.lineTo(2, size / 2);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
		return ctx.getImageData(0, 0, size, size);
	}
	return new ImageData(size, size);
}

/** Construction hard-hat marker for budujesie.pl investments (dark olive). */
export function makeBudujesieIcon(): ImageData {
	const size = 28;
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (ctx) {
		ctx.fillStyle = "#365314";
		ctx.strokeStyle = "#ffffff";
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.arc(size / 2, 16, 8, Math.PI, 2 * Math.PI);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
		const w = 22;
		const h = 5;
		const x = (size - w) / 2;
		const y = 15;
		const r = 2.5;
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + w, y, x + w, y + h, r);
		ctx.arcTo(x + w, y + h, x, y + h, r);
		ctx.arcTo(x, y + h, x, y, r);
		ctx.arcTo(x, y, x + w, y, r);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
		return ctx.getImageData(0, 0, size, size);
	}
	return new ImageData(size, size);
}
