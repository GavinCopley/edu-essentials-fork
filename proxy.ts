import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAuthConfig } from "./lib/supabase-server";
import { isAuthUnavailable, isGoogleUser, isPublicPath } from "./lib/auth-policy";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (isPublicPath(path)) return NextResponse.next();
  let response = NextResponse.next({ request });
  response.headers.set("Cache-Control", "private, no-store");
  const reject = (status: number, destination: string) => {
    const result = path.startsWith("/api/")
      ? NextResponse.json({ error: status === 401 ? "Please sign in with Google." : "Authentication is temporarily unavailable." }, { status })
      : NextResponse.redirect(new URL(destination, request.url));
    response.cookies.getAll().forEach((cookie) => result.cookies.set(cookie));
    result.headers.set("Cache-Control", "private, no-store");
    return result;
  };
  // Missing credentials should fail closed even when the auth service is down.
  if (!request.cookies.getAll().some(({ name }) => /^sb-.*-auth-token(?:\.\d+)?$/.test(name))) return reject(401, "/login");
  try {
    const { url, key } = getSupabaseAuthConfig();
    const auth = createServerClient(url, key, {
      cookieOptions: { httpOnly: true, sameSite: "lax", path: "/", secure: request.nextUrl.protocol === "https:" },
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (items) => {
          items.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          response.headers.set("Cache-Control", "private, no-store");
          items.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });
    const { data: { user }, error } = await auth.auth.getUser();
    if (isAuthUnavailable(error)) return reject(503, "/login?error=unavailable");
    if (error || !isGoogleUser(user)) return reject(401, "/login?error=session");
    return response;
  } catch { return reject(503, "/login?error=unavailable"); }
}

export const config = {
  matcher: ["/((?!_next/|_vinext/|assets/|@vite/|@id/|favicon.svg$|og.png$|file.svg$|globe.svg$|window.svg$).*)"],
};
