import { Opcodes, Valtype } from "./wasmSpec.js";
import { number } from "./embedding.js";

// deno compat
if (typeof process === 'undefined' && typeof Deno !== 'undefined') {
  const textEncoder = new TextEncoder();
  globalThis.process = { argv: ['', '', ...Deno.args], stdout: { write: str => Deno.writeAllSync(Deno.stdout, textEncoder.encode(str)) } };
}

const performWasmOp = (op, a, b) => {
  switch (op) {
    case Opcodes.add: return a + b;
    case Opcodes.sub: return a - b;
    case Opcodes.mul: return a * b;
  }
};

export default (funcs, globals) => {
  const optLevel = parseInt(process.argv.find(x => x.startsWith('-O'))?.[2] ?? 1);
  if (optLevel === 0) return;

  const tailCall = process.argv.includes('-tail-call');
  if (tailCall) log('opt', 'tail call proposal is not widely implemented! (you used -tail-call)');

  if (optLevel >= 2 && !process.argv.includes('-opt-no-inline')) {
    // inline pass (very WIP)
    // get candidates for inlining
    // todo: pick smart in future (if func is used <N times? or?)
    const callsSelf = f => f.wasm.some(x => x[0] === Opcodes.call && x[1] === f.index);
    const suitableReturns = wasm => wasm.reduce((acc, x) => acc + (x[0] === Opcodes.return), 0) <= 1;
    const candidates = funcs.filter(x => x.name !== 'main' && Object.keys(x.locals).length === x.params.length && (x.returns.length === 0 || suitableReturns(x.wasm)) && !callsSelf(x) && !x.throws).reverse();
    if (optLog) {
      log('opt', `found inline candidates: ${candidates.map(x => x.name).join(', ')} (${candidates.length}/${funcs.length - 1})`);

      let reasons = {};
      for (const f of funcs) {
        if (f.name === 'main') continue;
        reasons[f.name] = [];

        if (f.name === 'main') reasons[f.name].push('main');
        if (Object.keys(f.locals).length !== f.params.length) reasons[f.name].push('cannot inline funcs with locals yet');
        if (f.returns.length !== 0 && !suitableReturns(f.wasm)) reasons[f.name].push('cannot inline funcs with multiple returns yet');
        if (callsSelf(f)) reasons[f.name].push('cannot inline func calling itself');
        if (f.throws) reasons[f.name].push('will not inline funcs throwing yet');
      }

      if (Object.values(reasons).some(x => x.length > 0)) console.log(`     reasons not:\n${Object.keys(reasons).filter(x => reasons[x].length > 0).map(x => `       ${x}: ${reasons[x].join(', ')}`).join('\n')}\n`)
    }

    for (const c of candidates) {
      const cWasm = c.wasm;

      for (const t of funcs) {
        const tWasm = t.wasm;
        if (t.name === c.name) continue; // skip self

        for (let i = 0; i < tWasm.length; i++) {
          const inst = tWasm[i];
          if (inst[0] === Opcodes.call && inst[1] === c.index) {
            if (optLog) log('opt', `inlining call for ${c.name} (in ${t.name})`);
            tWasm.splice(i, 1); // remove this call

            // add params as locals and set in reverse order
            const paramIdx = {};
            let localIdx = Math.max(-1, ...Object.values(t.locals).map(x => x.idx)) + 1;
            for (let j = c.params.length - 1; j >= 0; j--) {
              const name = `__porf_inline_${c.name}_param_${j}`;

              if (t.locals[name] === undefined) {
                t.locals[name] = { idx: localIdx++, type: c.params[j] };
              }

              const idx = t.locals[name].idx;
              paramIdx[j] = idx;

              tWasm.splice(i, 0, [ Opcodes.local_set, idx ]);
              i++;
            }

            let iWasm = cWasm.slice().map(x => x.slice()); // deep clone arr (depth 2)
            // remove final return
            if (iWasm.length !== 0 && iWasm[iWasm.length - 1][0] === Opcodes.return) iWasm = iWasm.slice(0, -1);

            // adjust local operands to go to correct param index
            for (const inst of iWasm) {
              if ((inst[0] === Opcodes.local_get || inst[0] === Opcodes.local_set) && inst[1] < c.params.length) {
                if (optLog) log('opt', `replacing local operand in inlined wasm (${inst[1]} -> ${paramIdx[inst[1]]})`);
                inst[1] = paramIdx[inst[1]];
              }
            }

            tWasm.splice(i, 0, ...iWasm);
            i += iWasm.length;
          }
        }

        if (t.index > c.index) t.index--; // adjust index if after removed func
        if (c.memory) t.memory = true;
      }

      funcs.splice(funcs.indexOf(c), 1); // remove func from funcs
    }
  }

  if (process.argv.includes('-opt-inline-only')) return;

  // wasm transform pass
  for (const f of funcs) {
    const wasm = f.wasm;

    let depth = [];

    let getCount = {}, setCount = {};
    for (const x in f.locals) {
      getCount[f.locals[x].idx] = 0;
      setCount[f.locals[x].idx] = 0;
    }

    // main pass
    for (let i = 0; i < wasm.length; i++) {
      let inst = wasm[i];

      if (inst[0] === Opcodes.if || inst[0] === Opcodes.loop || inst[0] === Opcodes.block) depth.push(inst[0]);
      if (inst[0] === Opcodes.end) depth.pop();

      if (inst[0] === Opcodes.local_get) getCount[inst[1]]++;
      if (inst[0] === Opcodes.local_set || inst[0] === Opcodes.local_tee) setCount[inst[1]]++;

      if (i < 1) continue;
      let lastInst = wasm[i - 1];

      if (lastInst[1] === inst[1] && lastInst[0] === Opcodes.local_set && inst[0] === Opcodes.local_get) {
        // replace set, get -> tee (sets and returns)
        // local.set 0
        // local.get 0
        // -->
        // local.tee 0

        lastInst[0] = Opcodes.local_tee; // replace last inst opcode (set -> tee)
        wasm.splice(i, 1); // remove this inst (get)

        getCount[inst[1]]--;
        i--;
        // if (optLog) log('opt', `consolidated set, get -> tee`);
        continue;
      }

      if ((lastInst[0] === Opcodes.local_get || lastInst[0] === Opcodes.global_get) && inst[0] === Opcodes.drop) {
        // replace get, drop -> nothing
        // local.get 0
        // drop
        // -->
        //

        getCount[lastInst[1]]--;

        wasm.splice(i - 1, 2); // remove this inst and last
        i -= 2;
        continue;
      }

      if (lastInst[0] === Opcodes.local_tee && inst[0] === Opcodes.drop) {
        // replace tee, drop -> set
        // local.tee 0
        // drop
        // -->
        // local.set 0

        getCount[lastInst[1]]--;

        lastInst[0] = Opcodes.local_set; // change last op

        wasm.splice(i, 1); // remove this inst
        i--;
        continue;
      }

      if ((lastInst[0] === Opcodes.i32_const || lastInst[0] === Opcodes.i64_const || lastInst[0] === Opcodes.f64_const) && inst[0] === Opcodes.drop) {
        // replace const, drop -> <nothing>
        // i32.const 0
        // drop
        // -->
        // <nothing>>

        wasm.splice(i - 1, 2); // remove this inst
        i -= 2;
        continue;
      }

      if (inst[0] === Opcodes.eq && lastInst[0] === Opcodes.const && lastInst[1] === 0 && valtype !== 'f64') {
        // replace const 0, eq -> eqz
        // i32.const 0
        // i32.eq
        // -->
        // i32.eqz

        inst[0] = Opcodes.eqz[0][0]; // eq -> eqz
        wasm.splice(i - 1, 1); // remove const 0
        i--;
        continue;
      }

      if (inst[0] === Opcodes.i32_wrap_i64 && (lastInst[0] === Opcodes.i64_extend_i32_s || lastInst[0] === Opcodes.i64_extend_i32_u)) {
        // remove unneeded i32 -> i64 -> i32
        // i64.extend_i32_s
        // i32.wrap_i64
        // -->
        // <nothing>

        wasm.splice(i - 1, 2); // remove this inst and last
        i -= 2;
        // if (optLog) log('opt', `removed redundant i32 -> i64 -> i32 conversion ops`);
        continue;
      }

      if (inst[0] === Opcodes.i32_trunc_sat_f64_s[0] && (lastInst[0] === Opcodes.f64_convert_i32_u || lastInst[0] === Opcodes.f64_convert_i32_s)) {
        // remove unneeded i32 -> f64 -> i32
        // f64.convert_i32_s || f64.convert_i32_u
        // i32.trunc_sat_f64_s || i32.trunc_sat_f64_u
        // -->
        // <nothing>

        wasm.splice(i - 1, 2); // remove this inst and last
        i -= 2;
        // if (optLog) log('opt', `removed redundant i32 -> f64 -> i32 conversion ops`);
        continue;
      }

      if (tailCall && lastInst[0] === Opcodes.call && inst[0] === Opcodes.return) {
        // replace call, return with tail calls (return_call)
        // call X
        // return
        // -->
        // return_call X

        lastInst[0] = Opcodes.return_call; // change last inst return -> return_call

        wasm.splice(i, 1); // remove this inst (return)
        i--;
        if (optLog) log('opt', `tail called return, call`);
        continue;
      }

      if (false && i === wasm.length - 1 && inst[0] === Opcodes.return) {
        // replace final return, end -> end (wasm has implicit return)
        // return
        // end
        // -->
        // end

        wasm.splice(i, 1); // remove this inst (return)
        i--;
        // if (optLog) log('opt', `removed redundant return at end`);
        continue;
      }

      if (i < 2) continue;
      const lastLastInst = wasm[i - 2];

      if (depth.length === 2) {
        // hack to remove unneeded before get in for loops with (...; i++)
        if (lastLastInst[0] === Opcodes.end && lastInst[1] === inst[1] && lastInst[0] === Opcodes.local_get && inst[0] === Opcodes.local_get) {
          // local.get 1
          // local.get 1
          // -->
          // local.get 1

          // remove drop at the end as well
          if (wasm[i + 4][0] === Opcodes.drop) {
            wasm.splice(i + 4, 1);
          }

          wasm.splice(i, 1); // remove this inst (second get)
          i--;
          continue;
        }
      }

      if (lastLastInst[1] === inst[1] && inst[0] === Opcodes.local_get && lastInst[0] === Opcodes.local_tee && lastLastInst[0] === Opcodes.local_set) {
        // local.set x
        // local.tee y
        // local.get x
        // -->
        // <nothing>

        wasm.splice(i - 2, 3); // remove this, last, 2nd last insts
        if (optLog) log('opt', `removed redundant inline param local handling`);
        i -= 3;
        continue;
      }
    }

    if (optLevel < 2) continue;

    if (optLog) log('opt', `get counts: ${Object.keys(f.locals).map(x => `${x} (${f.locals[x].idx}): ${getCount[f.locals[x].idx]}`).join(', ')}`);

    // remove unneeded var: remove pass
    // locals only got once. we don't need to worry about sets/else as these are only candidates and we will check for matching set + get insts in wasm
    let unneededCandidates = Object.keys(getCount).filter(x => getCount[x] === 0 || (getCount[x] === 1 && setCount[x] === 0)).map(x => parseInt(x));
    if (optLog) log('opt', `found unneeded locals candidates: ${unneededCandidates.join(', ')} (${unneededCandidates.length}/${Object.keys(getCount).length})`);

    // note: disabled for now due to instability
    if (unneededCandidates.length > 0 && false) for (let i = 0; i < wasm.length; i++) {
      if (i < 1) continue;

      const inst = wasm[i];
      const lastInst = wasm[i - 1];

      if (lastInst[1] === inst[1] && lastInst[0] === Opcodes.local_set && inst[0] === Opcodes.local_get && unneededCandidates.includes(inst[1])) {
        // local.set N
        // local.get N
        // -->
        // <nothing>

        wasm.splice(i - 1, 2); // remove insts
        i -= 2;
        delete f.locals[Object.keys(f.locals)[inst[1]]]; // remove from locals
        if (optLog) log('opt', `removed redundant local (get set ${inst[1]})`);
      }

      if (inst[0] === Opcodes.local_tee && unneededCandidates.includes(inst[1])) {
        // local.tee N
        // -->
        // <nothing>

        wasm.splice(i, 1); // remove inst
        i--;

        const localName = Object.keys(f.locals)[inst[1]];
        const removedIdx = f.locals[localName].idx;
        delete f.locals[localName]; // remove from locals

        // fix locals index for locals after
        for (const x in f.locals) {
          const local = f.locals[x];
          if (local.idx > removedIdx) local.idx--;
        }

        for (const inst of wasm) {
          if ((inst[0] === Opcodes.local_get || inst[0] === Opcodes.local_set || inst[0] === Opcodes.local_tee) && inst[1] > removedIdx) inst[1]--;
        }

        unneededCandidates.splice(unneededCandidates.indexOf(inst[1]), 1);
        unneededCandidates = unneededCandidates.map(x => x > removedIdx ? (x - 1) : x);

        if (optLog) log('opt', `removed redundant local ${localName} (tee ${inst[1]})`);
      }
    }

    const useCount = {};
    for (const x in f.locals) useCount[f.locals[x].idx] = 0;

    // final pass
    depth = [];
    for (let i = 0; i < wasm.length; i++) {
      let inst = wasm[i];
      if (inst[0] === Opcodes.local_get || inst[0] === Opcodes.local_set || inst[0] === Opcodes.local_tee) useCount[inst[1]]++;

      if (inst[0] === Opcodes.block) {
        // remove unneeded blocks (no brs inside)
        // block
        //   ...
        // end
        // -->
        // ...

        let hasBranch = false, j = i, depth = 0;
        for (; j < wasm.length; j++) {
          const op = wasm[j][0];
          if (op === Opcodes.if || op === Opcodes.block || op === Opcodes.loop || op === Opcodes.try) depth++;
          if (op === Opcodes.end) {
            depth--;
            if (depth <= 0) break;
          }
          if (op === Opcodes.br) {
            hasBranch = true;
            break;
          }
        }

        if (!hasBranch) {
          wasm.splice(i, 1); // remove this inst (block)
          i--;
          inst = wasm[i];

          wasm.splice(j - 1, 1); // remove end of this block

          if (optLog) log('opt', `removed unneeded block in for loop`);
        }
      }

      if (inst[0] === Opcodes.if || inst[0] === Opcodes.loop || inst[0] === Opcodes.block) depth.push(inst[0]);
      if (inst[0] === Opcodes.end) depth.pop();

      if (i < 2) continue;
      const lastInst = wasm[i - 1];
      const lastLastInst = wasm[i - 2];

      // todo: add more math ops
      if (optLevel >= 3 && (inst[0] === Opcodes.add || inst[0] === Opcodes.sub || inst[0] === Opcodes.mul) && lastLastInst[0] === Opcodes.const && lastInst[0] === Opcodes.const) {
        // inline const math ops
        // i32.const a
        // i32.const b
        // i32.add
        // -->
        // i32.const a + b

        // does not work with leb encoded
        if (lastInst.length > 2 || lastLastInst.length > 2) continue;

        let a = lastLastInst[1];
        let b = lastInst[1];

        const val = performWasmOp(inst[0], a, b);
        if (optLog) log('opt', `inlined math op (${a} ${inst[0].toString(16)} ${b} -> ${val})`);

        wasm.splice(i - 2, 3, ...number(val)); // remove consts, math op and add new const
        i -= 2;
      }
    }

    const localIdxs = Object.values(f.locals).map(x => x.idx);
    // remove unused locals (cleanup)
    for (const x in useCount) {
      if (useCount[x] === 0) {
        const name = Object.keys(f.locals)[localIdxs.indexOf(parseInt(x))];
        if (optLog) log('opt', `removed internal local ${x} (${name})`);
        delete f.locals[name];
      }
    }

    if (optLog) log('opt', `final use counts: ${Object.keys(f.locals).map(x => `${x} (${f.locals[x].idx}): ${useCount[f.locals[x].idx]}`).join(', ')}`);
  }

  // return funcs;
};