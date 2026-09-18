import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";

export const auth = betterAuth({
	// Without this, better-auth derives the origin per request and warns on
	// every boot of an unconfigured (fresh) clone.
	baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
	emailAndPassword: {
		enabled: true,
	},
	plugins: [tanstackStartCookies()],
});
