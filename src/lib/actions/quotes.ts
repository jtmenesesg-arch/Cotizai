"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentOrganizationId } from "@/lib/supabase/helpers";
import { generateQuoteWithAI } from "@/lib/ai";
import { generateQuotePdfBuffer } from "@/lib/pdf";
import { sendQuoteEmail } from "@/lib/email/resend";
import { redirect } from "next/navigation";

export async function generateQuoteFromRequest(
  formData: FormData
): Promise<void> {
  const organizationId = await getCurrentOrganizationId();

  const customerId = String(formData.get("customer_id") || "");
  const request = String(formData.get("request") || "").trim();

  if (!customerId || !request) {
    throw new Error("Missing required fields");
  }

  if (!organizationId) {
    throw new Error("Unauthorized");
  }

  const supabase = createSupabaseServerClient();

  const { data: organization } = await supabase
    .from("organizations")
    .select("id, name, description, logo_url")
    .eq("id", organizationId)
    .single();

  const { data: customer } = await supabase
    .from("customers")
    .select("id, name, email, company")
    .eq("id", customerId)
    .eq("organization_id", organizationId)
    .single();

  const { data: services } = await supabase
    .from("services")
    .select("id, name, description, base_price")
    .eq("organization_id", organizationId);

  if (!organization || !customer || !services) {
    throw new Error("Missing data for quote generation.");
  }

  const aiQuote = await generateQuoteWithAI({
    organization,
    customer,
    services,
    request,
  });

  const serviceById = new Map(services.map((service) => [service.id, service]));
  const serviceByName = new Map(
    services.map((service) => [service.name.toLowerCase(), service])
  );

  const sanitizedItems = aiQuote.line_items
    .map((item) => {
      const matchById = item.service_id
        ? serviceById.get(item.service_id)
        : undefined;
      const matchByName = serviceByName.get(item.name.toLowerCase());
      const match = matchById ?? matchByName;
      if (!match) {
        return null;
      }
      return {
        quote_id: "",
        service_id: match.id,
        name: match.name,
        description: item.description ?? match.description ?? null,
        price: item.price,
      };
    })
    .filter(Boolean) as {
    quote_id: string;
    service_id: string;
    name: string;
    description: string | null;
    price: number;
  }[];

  if (sanitizedItems.length === 0) {
    throw new Error("AI could not map services to catalog.");
  }

  const totalPrice = sanitizedItems.reduce(
    (sum, item) => sum + Number(item.price || 0),
    0
  );

  const { data: quote, error: quoteError } = await supabase
    .from("quotes")
    .insert({
      organization_id: organizationId,
      customer_id: customerId,
      title: aiQuote.title,
      description: aiQuote.description,
      total_price: totalPrice,
      status: "draft",
    })
    .select("id")
    .single();

  if (quoteError || !quote) {
    throw new Error(quoteError?.message ?? "Unable to create quote.");
  }

  const items = sanitizedItems.map((item) => ({
    ...item,
    quote_id: quote.id,
  }));

  const { error: itemsError } = await supabase
    .from("quote_items")
    .insert(items);

  if (itemsError) {
    throw new Error(itemsError.message);
  }

  const quoteId = quote.id;
  redirect(`/quotes/${quoteId}`);
}

export const generateQuotePdf = async (quoteId: string) => {
  const organizationId = await getCurrentOrganizationId();
  if (!organizationId) {
    throw new Error("Unauthorized");
  }

  const supabase = createSupabaseServerClient();

  const { data: quote } = await supabase
    .from("quotes")
    .select(
      "id, title, description, total_price, created_at, customer_id, pdf_url"
    )
    .eq("id", quoteId)
    .eq("organization_id", organizationId)
    .single();

  if (!quote) {
    throw new Error("Quote not found.");
  }

  const { data: organization } = await supabase
    .from("organizations")
    .select("name, logo_url")
    .eq("id", organizationId)
    .single();

  const { data: customer } = await supabase
    .from("customers")
    .select("name, company")
    .eq("id", quote.customer_id)
    .eq("organization_id", organizationId)
    .single();

  const { data: items } = await supabase
    .from("quote_items")
    .select("name, description, price")
    .eq("quote_id", quoteId);

  if (!organization || !customer || !items) {
    throw new Error("Missing quote data.");
  }

  const pdfBuffer = await generateQuotePdfBuffer({
    organization,
    customer,
    quote: {
      ...quote,
      public_url: `${process.env.NEXT_PUBLIC_APP_URL}/q/${quote.id}`,
    },
    items,
  });

  const filePath = `${quoteId}.pdf`;
  const { data: upload, error: uploadError } = await supabase.storage
    .from("quotes")
    .upload(filePath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError || !upload) {
    throw new Error(uploadError?.message ?? "Unable to upload PDF.");
  }

  const { data: publicUrl } = supabase.storage
    .from("quotes")
    .getPublicUrl(upload.path);

  await supabase
    .from("quotes")
    .update({ pdf_url: publicUrl.publicUrl })
    .eq("id", quoteId);

  return publicUrl.publicUrl;
};

export const sendQuote = async (quoteId: string) => {
  const organizationId = await getCurrentOrganizationId();
  if (!organizationId) {
    throw new Error("Unauthorized");
  }

  const supabase = createSupabaseServerClient();

  const { data: quote } = await supabase
    .from("quotes")
    .select(
      "id, title, description, total_price, created_at, customer_id"
    )
    .eq("id", quoteId)
    .eq("organization_id", organizationId)
    .single();

  if (!quote) {
    throw new Error("Quote not found.");
  }

  const { data: organization } = await supabase
    .from("organizations")
    .select("id, name, logo_url")
    .eq("id", organizationId)
    .single();

  const { data: emailSettings } = await supabase
    .from("email_settings")
    .select("from_name, from_email, reply_to, signature")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const { data: customer } = await supabase
    .from("customers")
    .select("name, email, company")
    .eq("id", quote.customer_id)
    .eq("organization_id", organizationId)
    .single();

  const { data: items } = await supabase
    .from("quote_items")
    .select("name, description, price")
    .eq("quote_id", quoteId);

  if (!organization || !customer || !items) {
    throw new Error("Missing quote data.");
  }

  const pdfBuffer = await generateQuotePdfBuffer({
    organization,
    customer,
    quote: {
      ...quote,
      public_url: `${process.env.NEXT_PUBLIC_APP_URL}/q/${quote.id}`,
    },
    items,
  });

  const filePath = `${quoteId}.pdf`;
  const { data: upload, error: uploadError } = await supabase.storage
    .from("quotes")
    .upload(filePath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError || !upload) {
    throw new Error(uploadError?.message ?? "Unable to upload PDF.");
  }

  const { data: publicUrl } = supabase.storage
    .from("quotes")
    .getPublicUrl(upload.path);

  await supabase
    .from("quotes")
    .update({ pdf_url: publicUrl.publicUrl, status: "sent" })
    .eq("id", quoteId);

  const threadSubject = `Quote: ${quote.title}`;
  const { data: thread } = await supabase
    .from("email_threads")
    .insert({
      organization_id: organizationId,
      customer_id: quote.customer_id,
      quote_id: quoteId,
      subject: threadSubject,
      status: "open",
    })
    .select("id")
    .single();

  const quoteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/q/${quote.id}`;
  const html = `
    <div style="font-family: 'Helvetica Neue', Arial, sans-serif; color: #111827;">
      <p>Hi ${customer.name},</p>
      <p>Attached is your sales quote from ${organization.name}. Let us know if you'd like adjustments.</p>
      <p>
        View the quote here: <a href="${quoteUrl}">Open Quote</a>
      </p>
      <p>${emailSettings?.signature ?? ""}</p>
    </div>
  `;

  const fromName = emailSettings?.from_name ?? organization.name;
  const fromEmail = emailSettings?.from_email ?? "quotes@quoteai.app";

  await sendQuoteEmail({
    to: customer.email,
    from: `${fromName} <${fromEmail}>`,
    subject: threadSubject,
    html,
    attachments: [
      {
        filename: `${quote.title}.pdf`,
        content: Buffer.from(pdfBuffer).toString("base64"),
      },
    ],
    replyTo: emailSettings?.reply_to ?? fromEmail,
    headers: thread?.id
      ? { "X-QuoteAI-Thread-Id": thread.id }
      : undefined,
  });

  if (thread?.id) {
    await supabase.from("email_messages").insert({
      thread_id: thread.id,
      direction: "outbound",
      content: html,
      is_suggested: false,
    });
  }

  return thread?.id as string | undefined;
};
