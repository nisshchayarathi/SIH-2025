import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { GoogleGenAI } from "@google/genai";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { Pinecone } from "@pinecone-database/pinecone";

interface ChatHistory {
  role: string;
  parts: any;
}

const ai = new GoogleGenAI({});

const embeddings = new GoogleGenerativeAIEmbeddings({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "text-embedding-004",
});

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
});
const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX_NAME!);

// Retry helper
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delayMs = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (error.status === 503 && attempt < maxRetries) {
        console.warn(`Attempt ${attempt} failed. Retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
      } else {
        throw error;
      }
    }
  }
  throw new Error("Max retries reached without success");
}

export async function POST(req: Request) {
  console.log("🌿 AyurBot Chat API called");

  const session = await getServerSession(authOptions);
  console.log(
    "👤 Session:",
    session
      ? `Logged in as ${session.user?.email} (${(session.user as any)?.role})`
      : "Anonymous user"
  );

  try {
    const { question, history } = await req.json();
    console.log("🪷 Question received:", question);
    console.log("📚 History length:", history?.length || 0);

    // Format chat history
    const formattedHistory: ChatHistory[] = (history || [])
      .filter(
        (msg: any) =>
          msg &&
          msg.role &&
          Array.isArray(msg.parts) &&
          msg.parts.length > 0 &&
          msg.parts[0].text
      )
      .map((msg: any) => ({
        role: msg.role,
        parts: [{ text: msg.parts[0].text }],
      }));

    // Extract user history
    const userHistory = formattedHistory
      .filter((msg) => msg.role === "user")
      .map((msg) => msg.parts[0].text);

    const followUpQuestion = question;

    // ✨ Step 1: Rewrite follow-up into standalone question
    console.log("🪄 Rewriting follow-up question...");
    const rewriteResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Previous user messages:\n${userHistory.join(
                "\n"
              )}\nFollow-up question: ${followUpQuestion}`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: `You are a helpful Ayurveda query rewriter. 
Rephrase the follow-up into a standalone question. Output only the rewritten question, no explanations. 
If it's a greeting (hi, hello, how can you help me), keep its meaning the same.`,
      },
    });

    const enhancedQuestion =
      rewriteResponse.text || followUpQuestion || "No question generated.";
    console.log("✨ Enhanced Question:", enhancedQuestion);

    // Replace last message with rewritten one
    if (
      formattedHistory.length > 0 &&
      formattedHistory[formattedHistory.length - 1].role === "user"
    ) {
      formattedHistory.pop();
    }
    formattedHistory.push({
      role: "user",
      parts: [{ text: enhancedQuestion }],
    });

    console.log(
      "🧾 Final formatted history:",
      JSON.stringify(formattedHistory, null, 2)
    );

    // ✨ Step 2: Embedding + Pinecone retrieval
    const queryVector = await embeddings.embedQuery(enhancedQuestion);
    const searchResults = await pineconeIndex.query({
      topK: 10,
      vector: queryVector,
      includeMetadata: true,
    });

    const context = (searchResults.matches || [])
      .map((m) => String(m.metadata?.text ?? ""))
      .filter((t) => t.trim().length > 0)
      .join("\n\n---\n\n");

    // 🌿 AyurBot system instruction
    const systemInstruction = `You are AyurBot — a compassionate Ayurveda and yoga expert.
You specialize in holistic healing, diet, lifestyle, herbs, meditation, and wellness.
Use ONLY the provided context to answer. 
If context lacks the answer, reply: "I could not find the answer in the provided document. Would you like general Ayurvedic guidance instead?"
Keep your tone warm, natural, and caring. 
Explain simply and safely without prescribing medicines.
Context: ${context || "No relevant context found."}`;

    // ✨ Step 3: Generate final AyurBot answer
    console.log("🧘 Generating AyurBot response...");
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: formattedHistory,
      config: { systemInstruction, temperature: 0.7 },
    });

    const answer =
      response.text ||
      "I'm here to guide you on Ayurveda, yoga, and holistic well-being.";

    console.log("✅ AyurBot Answer:", answer.substring(0, 120) + "...");

    return NextResponse.json({ answer });
  } catch (error: any) {
    console.error("❌ AyurBot Chat API error:", error);
    console.error("Error details:", error.message, error.status);
    console.error("Full error object:", JSON.stringify(error, null, 2));

    if (error.message?.includes("API key") || error.status === 403) {
      return NextResponse.json(
        {
          error: "Configuration issue with AI service",
          details: "API key problem",
        },
        { status: 500 }
      );
    }

    if (error.message?.includes("quota") || error.status === 429) {
      return NextResponse.json(
        {
          error: "Service temporarily unavailable due to quota limits",
          details: "Try again later",
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        error: "Chat service temporarily unavailable",
        details: error.message || "Unknown error",
        errorType: error.constructor.name,
      },
      { status: 500 }
    );
  }
}
