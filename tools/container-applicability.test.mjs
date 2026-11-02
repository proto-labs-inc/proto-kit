import test from "node:test";
import assert from "node:assert/strict";
import { queryKey, hasCompleteAbsenceEvidence, observeContainerRules } from "./container-applicability.mjs";
import { validateResponsivePlan } from "./verify-screen.mjs";
import { widthsFor } from "./screen-verification.mjs";
import { headlessPage } from "./cdp/headless.mjs";
import { evaluate } from "./cdp/cdp.mjs";

const query = { source:"https://source.invalid/shared.css", name:"", condition:"(min-width: 420px)", selectors:[".unused"] };
function completePlan() {
  const inventory = {sourceUrl:"https://source.invalid/", states:[{id:"default",kind:"source"},{id:"dialog",kind:"source"}], breakpoints:[640]};
  return {inventory, responsiveCss:{sourceUrl:inventory.sourceUrl,capturedAt:"2026-10-14T00:00:00Z",breakpoints:[640],containerQueries:[query]},scenarios:[],
    containerObservations:inventory.states.flatMap(state => widthsFor(inventory).map(width => ({sourceUrl:inventory.sourceUrl,state:state.id,width,capturedAt:"2026-10-14T01:00:00Z",queries:[{key:queryKey(query),status:"absent",matches:0}]})))};
}
test("complete live evidence exempts an unused shared rule, not the rest of verification", () => {
  assert.equal(hasCompleteAbsenceEvidence(completePlan(),query),true);
  assert.doesNotThrow(()=>validateResponsivePlan(completePlan()));
});
for (const [name, change] of [
  ["missing width", p=>p.containerObservations.pop()],
  ["missing state", p=>p.containerObservations=p.containerObservations.filter(o=>o.state==="default")],
  ["wrong source", p=>p.containerObservations[0].sourceUrl="https://another.invalid/"],
  ["old evidence", p=>p.containerObservations[0].capturedAt="2026-10-13T00:00:00Z"],
  ["unknown selector", p=>p.containerObservations[0].queries[0].status="unknown"],
  ["matched hidden element", p=>p.containerObservations[0].queries[0]={key:queryKey(query),status:"matched",matches:1}],
  ["changed selector", p=>p.responsiveCss.containerQueries=[{...query,selectors:[".other"]}]],
  ["contradictory duplicate", p=>p.containerObservations.push({...p.containerObservations[0],queries:[{key:queryKey(query),status:"matched",matches:1}]})],
  ["missing states", p=>p.inventory.states=[]],
]) test(`unused rule exemption rejects ${name}`,()=>{
  const plan=completePlan();change(plan);
  assert.throws(()=>validateResponsivePlan(plan),/container-size/);
});
test("matching queries still accept executable resize tests",()=>{
  const plan=completePlan();plan.containerObservations=[];
  plan.scenarios=[{category:"responsive",target:"default",containerQuery:query.condition,steps:[{kind:"resize-container",selector:".cards",width:420}]}];
  assert.doesNotThrow(()=>validateResponsivePlan(plan));
});
test("live collector counts hidden and shadow elements and leaves dynamic selectors unknown",{skip:process.env.PROTO_BROWSER_TEST!=="1"},async()=>{
  const opened=await headlessPage("about:blank",{width:640,height:900});
  try {
    await evaluate(opened.page, `(()=>{document.body.innerHTML='<div class="hidden" hidden></div><div id="shadow"></div><div class="@[420px]:flex-row"></div>';document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<span class="inside"></span>'})()`);
    const selectors=[".unused",".hidden",".inside",".button:hover","& .nested","[",".\\@\\[420px\\]\\:flex-row"];
    const result=await evaluate(opened.page,`(${observeContainerRules.toString()})(${JSON.stringify(selectors.map(selector=>({...query,selectors:[selector]})))})`);
    assert.deepEqual(result.map(r=>r.status),["absent","matched","matched","unknown","unknown","unknown","matched"]);
    assert.deepEqual(result.map(r=>r.matches),[0,1,1,0,0,0,1]);
  }finally{await opened.close();}
});

test("boundary states do not require live-source container observations",()=>{
 const plan=completePlan();plan.inventory.states.push({id:"outside",kind:"prototype-boundary"});
 assert.equal(hasCompleteAbsenceEvidence(plan,query),true);
});
