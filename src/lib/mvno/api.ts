import "server-only";

// Adapter boundary to each MVNO's BSS/billing and payment systems.
// Replace MockMvnoApi with a real implementation per MVNO (keyed by slug)
// when their APIs are available; nothing else in the app needs to change.

export interface Balance {
  airtime: number;
  dataMb: number;
  minutes: number;
  sms: number;
  expiresAt: string;
  activeBundle: string | null;
}

export interface LineStatus {
  msisdn: string;
  state: "active" | "suspended" | "barred";
  kyc: "verified" | "pending";
  simType: "physical" | "esim";
  network: "4G" | "3G";
}

export interface PaymentResult {
  status: "success" | "failed";
  reference: string;
  message: string;
}

export interface MvnoApi {
  getBalance(msisdn: string): Promise<Balance>;
  getLineStatus(msisdn: string): Promise<LineStatus>;
  /** Starts a mobile money push (STK) and resolves when the customer approves. */
  chargeAndCredit(input: { msisdn: string; payerMsisdn: string; amount: number; description: string }): Promise<PaymentResult>;
}

function seeded(msisdn: string) {
  let h = 0;
  for (const ch of msisdn) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (n: number) => {
    h = (h * 1103515245 + 12345) >>> 0;
    return h % n;
  };
}

class MockMvnoApi implements MvnoApi {
  async getBalance(msisdn: string): Promise<Balance> {
    const r = seeded(msisdn);
    return {
      airtime: r(20) * 500 + r(10) * 50,
      dataMb: r(3000),
      minutes: r(300),
      sms: r(200),
      expiresAt: new Date(Date.now() + (1 + r(20)) * 86_400_000).toISOString(),
      activeBundle: ["700MB Daily", "60 Minutes", null, "Mega Value: 200 mins + 10GB"][r(4)],
    };
  }

  async getLineStatus(msisdn: string): Promise<LineStatus> {
    const r = seeded(msisdn + "line");
    return {
      msisdn,
      state: r(10) === 0 ? "suspended" : "active",
      kyc: r(6) === 0 ? "pending" : "verified",
      simType: r(5) === 0 ? "esim" : "physical",
      network: r(4) === 0 ? "3G" : "4G",
    };
  }

  async chargeAndCredit(input: { msisdn: string; amount: number }): Promise<PaymentResult> {
    await new Promise((res) => setTimeout(res, 1200)); // simulate STK approval round-trip
    const reference = Math.random().toString(36).slice(2, 12).toUpperCase();
    const ok = input.amount > 0 && input.amount <= 5_000_000; // PaxSente per-transaction limit
    return {
      status: ok ? "success" : "failed",
      reference,
      message: ok ? "Payment received" : "Payment declined",
    };
  }
}

const mock = new MockMvnoApi();

// Register real integrations here as they become available, e.g. { nova: new NovaBssApi() }.
const adapters: Record<string, MvnoApi> = {};

export function mvnoApi(mvnoSlug: string): MvnoApi {
  return adapters[mvnoSlug] ?? mock;
}
