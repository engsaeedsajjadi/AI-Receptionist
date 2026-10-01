"use client";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/dashboard/auth";
import { Badge, ErrorState, LoadingState, PageHeader } from "@/components/dashboard/ui";

type Billing = { subscription: null | { status:string; plan:{name:string; code:string; monthlyPrice:string; currency:string; voiceMinutes:number; aiTokens:number; storageBytes:string; maxAgents:number; maxUsers:number} }; usage:Array<{metric:string;total:string}>; invoices:Array<{id:string;number:string;status:string;amountDue:string;currency:string;issuedAt:string}> };
export default function BillingPage(){
 const {apiJson}=useAuth(); const [data,setData]=useState<Billing|null>(null); const [error,setError]=useState("");
 useEffect(()=>{apiJson<Billing>("/api/v1/billing").then(setData).catch((e:Error)=>setError(e.message));},[apiJson]);
 if(error) return <ErrorState message={error}/>; if(!data) return <LoadingState/>;
 const p=data.subscription?.plan; const usage=Object.fromEntries(data.usage.map(x=>[x.metric,Number(x.total)]));
 return <div><PageHeader title="صورتحساب و اشتراک" desc="پلن، سهمیه‌ها، مصرف و فاکتورهای سازمان"/>
 <div className="grid gap-4 lg:grid-cols-3">
  <section className="saas-panel lg:col-span-2"><div className="flex items-center justify-between"><div><p className="saas-eyebrow">پلن فعلی</p><h2 className="mt-2 text-2xl font-semibold">{p?.name ?? "Free"}</h2></div><Badge tone="green">{data.subscription?.status ?? "ACTIVE"}</Badge></div>
   <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4"><Quota label="دقیقه صوت" value={p?.voiceMinutes}/><Quota label="توکن AI" value={p?.aiTokens}/><Quota label="Agent" value={p?.maxAgents}/><Quota label="کاربر" value={p?.maxUsers}/></div>
  </section>
  <section className="saas-panel"><p className="saas-eyebrow">مصرف دوره</p><div className="mt-4 space-y-3">{Object.keys(usage).length?Object.entries(usage).map(([k,v])=><div key={k} className="flex justify-between border-b border-slate-100 pb-2 text-sm"><span>{k}</span><strong>{v.toLocaleString("fa-IR")}</strong></div>):<p className="text-sm text-slate-500">هنوز مصرفی ثبت نشده است.</p>}</div></section>
 </div>
 <section className="saas-panel mt-4"><h2 className="font-semibold">فاکتورها</h2><div className="mt-4 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-slate-500"><th>شماره</th><th>وضعیت</th><th>مبلغ</th><th>تاریخ</th></tr></thead><tbody>{data.invoices.map(i=><tr key={i.id} className="border-t border-slate-100"><td>{i.number}</td><td>{i.status}</td><td>{i.amountDue} {i.currency}</td><td>{new Date(i.issuedAt).toLocaleDateString("fa-IR")}</td></tr>)}</tbody></table></div></section>
 </div>
}
function Quota({label,value}:{label:string;value:number|undefined}){return <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-lg font-semibold">{(value??0).toLocaleString("fa-IR")}</p></div>}
