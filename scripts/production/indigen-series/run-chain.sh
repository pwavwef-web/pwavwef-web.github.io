#!/bin/sh
# usage: run-chain.sh <video> <scene-id>...  -> render those clips, then upload, build the timeline and render the final in AZ Studio
v=$1; shift
L=exports/indigen-contributor-series/_work
node scripts/production/indigen-series/render-all.mjs $v "$@" > $L/render-$v-fix.log 2>&1 || exit 1
node scripts/production/run.mjs scripts/production/indigen-series/03-assemble.ts upload $v > $L/asm-$v-fix.log 2>&1 || exit 1
node scripts/production/run.mjs scripts/production/indigen-series/03-assemble.ts timeline $v >> $L/asm-$v-fix.log 2>&1 || exit 1
node scripts/production/run.mjs scripts/production/indigen-series/03-assemble.ts render $v final >> $L/asm-$v-fix.log 2>&1
echo done > $L/chain-$v.done
