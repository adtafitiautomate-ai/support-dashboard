import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the Supabase session cookie and does an optimistic auth redirect.
// Real authorization happens in RLS and in each route handler.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims);
  const { pathname } = request.nextUrl;

  if (!signedIn && pathname !== "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (signedIn && (pathname === "/login" || pathname === "/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/inbox";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  // Skip static assets, public files (images, icons, fonts…) and the public WhatsApp webhook.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/whatsapp|.*\\.(?:webp|png|jpe?g|gif|svg|ico|avif|woff2?|txt|xml)$).*)"],
};
