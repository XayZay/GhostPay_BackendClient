import * as admin from "firebase-admin";
import * as dotenv from "dotenv";
import {FieldValue, Timestamp} from "firebase-admin/firestore";

dotenv.config();

const MERCHANT_ID = "+2348031234567";
const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ??
  process.env.GCLOUD_PROJECT ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  "ghost-pay-kora-hackathon";

if (!admin.apps.length) {
  admin.initializeApp({projectId: PROJECT_ID});
}

const db = admin.firestore();

const daysAgo = (days: number): Timestamp => {
  const millis = Date.now() - days * 24 * 60 * 60 * 1000;
  return Timestamp.fromMillis(millis);
};

const transactions = [
  {id: "demo_tx_01", item: "lace fabric", amount: 85000, status: "paid", customer: "+2348031110001", days: 0.3},
  {id: "demo_tx_02", item: "ankara material", amount: 42000, status: "paid", customer: "+2348031110002", days: 0.8},
  {id: "demo_tx_03", item: "sneakers", amount: 65000, status: "paid", customer: "+2348031110003", days: 1.1},
  {id: "demo_tx_04", item: "wristwatch", amount: 27500, status: "paid", customer: "+2348031110004", days: 1.7},
  {id: "demo_tx_05", item: "hair extensions", amount: 75000, status: "paid", customer: "+2348031110005", days: 2.2},
  {id: "demo_tx_06", item: "phone case", amount: 2500, status: "paid", customer: "+2348031110006", days: 2.9},
  {id: "demo_tx_07", item: "earrings", amount: 1500, status: "paid", customer: "+2348031110007", days: 3.4},
  {id: "demo_tx_08", item: "handbag", amount: 55000, status: "paid", customer: "+2348031110008", days: 4.1},
  {id: "demo_tx_09", item: "body cream", amount: 8000, status: "paid", customer: "+2348031110009", days: 5.2},
  {id: "demo_tx_10", item: "fabric", amount: 18000, status: "paid", customer: "+2348031110010", days: 6.5},
  {id: "demo_tx_11", item: "ankara material", amount: 32000, status: "pending", customer: "+2348031110011", days: 0.1},
  {id: "demo_tx_12", item: "sneakers", amount: 48500, status: "pending", customer: "+2348031110012", days: 0.05},
] as const;

const seedDemo = async (): Promise<void> => {
  const batch = db.batch();
  const merchantRef = db.collection("merchants").doc(MERCHANT_ID);

  batch.set(merchantRef, {
    name: "Mama Chisom Boutique",
    phone: MERCHANT_ID,
    totalCollected: 2310000,
    transactionCount: 47,
    updatedAt: FieldValue.serverTimestamp(),
  }, {merge: true});

  for (const tx of transactions) {
    const createdAt = daysAgo(tx.days);
    const transactionRef = db.collection("transactions").doc(tx.id);

    batch.set(transactionRef, {
      merchantId: MERCHANT_ID,
      status: tx.status,
      amount: tx.amount,
      customer: tx.customer,
      item: tx.item,
      createdAt,
      ...(tx.status === "paid" ? {paidAt: createdAt} : {}),
    });
  }

  await batch.commit();

  console.log("Seeded demo merchant and transactions", {
    projectId: PROJECT_ID,
    merchantId: MERCHANT_ID,
    transactions: transactions.length,
    paid: transactions.filter((tx) => tx.status === "paid").length,
    pending: transactions.filter((tx) => tx.status === "pending").length,
  });
};

seedDemo().catch((error) => {
  console.error("Failed to seed demo data", {error});
  process.exitCode = 1;
});