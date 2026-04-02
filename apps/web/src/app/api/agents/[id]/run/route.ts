import { NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const agentId = params.id;
    const body = await request.json();

    // Forward the native access_token cookie as Bearer token to the backend.
    // The cookie already contains a valid JWT with the correct company_id,
    // issued by the backend's own auth system at login time.
    const token = request.cookies.get("access_token")?.value;
    if (!token) {
      return NextResponse.json(
        { error: "Not authenticated — please log in" },
        { status: 401 }
      );
    }

    const backendUrl = `http://localhost:4000/api/agents/${agentId}/run`;
    const response = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      let errorMsg = `Backend error: ${response.status}`;
      try {
        const errorData = JSON.parse(text);
        if (typeof errorData.error === "string") {
          errorMsg = errorData.error;
        } else if (typeof errorData.error === "object" && errorData.error?.message) {
          errorMsg = errorData.error.message;
        } else if (errorData.message) {
          errorMsg = errorData.message;
        }
      } catch {
        errorMsg = text || errorMsg;
      }
      console.error("[agents/run] Backend error:", errorMsg);
      return NextResponse.json(
        { error: errorMsg },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[agents/run] Error:", message);
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
