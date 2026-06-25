import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const DASHBOARD_REALM = "ERP API Debug Center";

function getDashboardCredentials() {
  const username =
    process.env.DEBUG_CENTER_DASHBOARD_USER ?? process.env.DEBUG_CENTER_BASIC_AUTH_USER;
  const password =
    process.env.DEBUG_CENTER_DASHBOARD_PASSWORD ?? process.env.DEBUG_CENTER_BASIC_AUTH_PASSWORD;

  if (!username || !password) return null;

  return { username, password };
}

function safeEquals(left: string, right: string) {
  if (left.length !== right.length) return false;

  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return result === 0;
}

function parseBasicAuth(authorization: string | null) {
  if (!authorization?.startsWith("Basic ")) return null;

  try {
    const decoded = atob(authorization.slice("Basic ".length));
    const separatorIndex = decoded.indexOf(":");

    if (separatorIndex === -1) return null;

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function isAuthorized(request: NextRequest) {
  const credentials = getDashboardCredentials();

  if (!credentials) {
    return process.env.NODE_ENV !== "production";
  }

  const auth = parseBasicAuth(request.headers.get("authorization"));
  if (!auth) return false;

  return (
    safeEquals(auth.username, credentials.username) &&
    safeEquals(auth.password, credentials.password)
  );
}

function unauthorizedResponse() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${DASHBOARD_REALM}", charset="UTF-8"`,
    },
  });
}

function authNotConfiguredResponse() {
  return new Response("Dashboard authentication is not configured", {
    status: 503,
  });
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === "/api/logs" && request.method === "POST") {
    return NextResponse.next();
  }

  if (!getDashboardCredentials() && process.env.NODE_ENV === "production") {
    return authNotConfiguredResponse();
  }

  if (!isAuthorized(request)) {
    return unauthorizedResponse();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
