import test from "node:test";
import assert from "node:assert/strict";
import {layoutProblems} from "./verify-screen.mjs";
test("clipping checks ignore inaccessible modal backgrounds but still reject active clipped controls",()=>{
 const parent={parentElement:null,getBoundingClientRect:()=>({left:0,right:100,top:0,bottom:100})};
 const control={id:"action",parentElement:parent,closest:()=>null,checkVisibility:()=>true,getBoundingClientRect:()=>({left:0,right:150,top:0,bottom:20,width:150,height:20}),matches:()=>false};
 const window={innerWidth:200,innerHeight:200,document:{documentElement:{scrollWidth:200},querySelectorAll:()=>[control]},getComputedStyle:()=>({overflowX:"hidden",overflowY:"visible"})};
 assert.deepEqual(layoutProblems(window),["Control clipped by ancestor: action"]);
 control.closest=()=>parent;
 assert.deepEqual(layoutProblems(window),[]);
});

test("viewport-fixed portals use the viewport when a scrolled body is locked",()=>{
 const body={parentElement:null,getBoundingClientRect:()=>({left:0,right:200,top:-1000,bottom:-800})};
 const control={id:"close",parentElement:body,closest:()=>null,checkVisibility:()=>true,getBoundingClientRect:()=>({left:50,right:80,top:50,bottom:80,width:30,height:30}),matches:()=>false};
 const window={innerWidth:200,innerHeight:200,document:{body,documentElement:{scrollWidth:200},querySelectorAll:()=>[control]},getComputedStyle:e=>e===body?{overflowX:"hidden",overflowY:"hidden"}:{position:"fixed"}};
 assert.deepEqual(layoutProblems(window),[]);
 control.getBoundingClientRect=()=>({left:50,right:80,top:190,bottom:220,width:30,height:30});
 assert.deepEqual(layoutProblems(window),["Control clipped vertically by ancestor: close"]);
});
