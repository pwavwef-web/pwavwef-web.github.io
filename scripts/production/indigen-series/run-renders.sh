#!/bin/sh
# usage: run-renders.sh <tag> <video>...   renders the clips of the given videos one after another
tag=$1; shift
for v in "$@"; do node scripts/production/indigen-series/render-all.mjs $v > exports/indigen-contributor-series/_work/render-$v.log 2>&1; done
echo finished > exports/indigen-contributor-series/_work/renders.done.$tag
