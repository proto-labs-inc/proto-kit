import test from "node:test";
import assert from "node:assert/strict";
import {captureProfileFor,sampleVideos} from "./verify-screen.mjs";
test("video sampling is explicit and validated",()=>{
 assert.deepEqual(captureProfileFor({capture:{videoTimeMs:1000}}),{videoTimeMs:1000});
 assert.deepEqual(captureProfileFor({capture:{videoTimeMs:1000}},{capture:{}}),{});
 for(const value of [-1,Infinity,"1"])assert.throws(()=>captureProfileFor({capture:{videoTimeMs:value}}),/videoTimeMs/);
});
test("video sampling seeks original media and rejects out-of-range times",async()=>{
 const video={src:"fixture.webm",readyState:4,duration:4,currentTime:0,seeking:false,pause(){this.paused=true}};
 assert.equal(await sampleVideos({querySelectorAll:()=>[video]},1000),1);
 assert.equal(video.currentTime,1);assert.equal(video.paused,true);
 await assert.rejects(sampleVideos({querySelectorAll:()=>[video]},5000),/exceeds duration/);
});
