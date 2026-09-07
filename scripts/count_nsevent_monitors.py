#!/usr/bin/env python3
"""
Count the AppKit NSEvent *local event monitors* held by a running macOS process
and histogram them by the code that installed them.

    python3 scripts/count_nsevent_monitors.py <pid>      # e.g. the Peers Flow main process

Why this exists: on macOS 26 AppKit's tracking-area manager orphans one
monitor every time a drag leaves the window with a button held, and every
orphan re-arms itself on each click. -[NSApplication sendEvent:] walks the
whole monitor table for every mouse move / key press, so a day of use left the
main process with 173k monitors and 15–80% CPU on input (2026-09-07). A healthy
process holds a handful (spell checker, key-down monitor, a remote view).
Nothing in the app can remove them; only a restart does. Run this to tell "the
leak is back" from ordinary load.

How: attaches lldb (pauses the target for ~1 s, then detaches), locates the
private observer NSHashTable by disassembling `_NSSendEventToObservers` (the
table is the receiver of its `allObjects` send), and reads each observer's
event mask and handler block. Diagnostic only — private AppKit layout, macOS
arm64. Loaded by lldb as a command module when run via the CLI wrapper below.
"""
import collections
import os
import re
import struct
import sys

PTR_MASK = 0x0000FFFFFFFFFFFF  # strip PAC / tag bits
OBSERVER_MASK_OFF = 8   # _NSEventObserver._mask
OBSERVER_BLOCK_OFF = 16  # _NSEventObserver._block
BLOCK_INVOKE_OFF = 16


def _find_table(debugger):
    """Address of the global NSHashTable of local monitors, from the disassembly."""
    import lldb
    ret = lldb.SBCommandReturnObject()
    debugger.GetCommandInterpreter().HandleCommand('disassemble -n _NSSendEventToObservers -c 40', ret)
    lines = ret.GetOutput().splitlines()
    loads = {}  # reg -> address it was loaded from
    for i, line in enumerate(lines):
        m = re.search(r'0x([0-9a-f]+) <\+\d+>:\s+adrp\s+(x\d+), (\d+)', line)
        if not m or i + 1 >= len(lines):
            continue
        pc, page_reg, pages = int(m.group(1), 16), m.group(2), int(m.group(3))
        m2 = re.search(r'ldr\s+(x\d+), \[%s, #0x([0-9a-f]+)\]' % page_reg, lines[i + 1])
        if m2:
            loads[m2.group(1)] = (pc & ~0xFFF) + pages * 0x1000 + int(m2.group(2), 16)
    for i, line in enumerate(lines):
        if 'objc_msgSend$allObjects' not in line:
            continue
        for back in range(i - 1, max(i - 6, -1), -1):
            m = re.search(r'mov\s+x0, (x\d+)', lines[back])
            if m and m.group(1) in loads:
                return loads[m.group(1)]
    return None


def _sym(target, addr):
    sc = target.ResolveLoadAddress(addr)
    s, mod = sc.GetSymbol(), sc.GetModule()
    name = s.GetName() if s.IsValid() else '?'
    return '%s`%s' % (mod.GetFileSpec().GetFilename() if mod else '?', name)


def nsevent_monitors(debugger, command, ctx, result, internal_dict):
    import lldb
    target = debugger.GetSelectedTarget()
    process = target.GetProcess()
    err = lldb.SBError()
    table_slot = _find_table(debugger)
    if not table_slot:
        print('could not locate the observer table in _NSSendEventToObservers (AppKit layout changed?)', file=result)
        return
    table = process.ReadPointerFromMemory(table_slot, err)
    frame = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
    opts = lldb.SBExpressionOptions()
    opts.SetLanguage(lldb.eLanguageTypeObjC_plus_plus)
    opts.SetIgnoreBreakpoints(True)
    opts.SetTimeoutInMicroSeconds(20_000_000)
    # One in-target pass: observer pointer, mask and block-invoke address per entry.
    expr = (
        '(void*)({ id arr = (id)[(id)%d allObjects]; unsigned long n = (unsigned long)[arr count]; '
        'unsigned long* buf = (unsigned long*)malloc(n*24+8); buf[0]=n; '
        'for (unsigned long i=0;i<n;i++){ id o=(id)[arr objectAtIndex:i]; buf[1+i*3]=(unsigned long)o; '
        'buf[2+i*3]=*(unsigned long*)((char*)o+%d); '
        'unsigned long b=*(unsigned long*)((char*)o+%d) & 0x0000FFFFFFFFFFFFUL; '
        'buf[3+i*3]= b ? (*(unsigned long*)((char*)b+%d) & 0x0000FFFFFFFFFFFFUL) : 0;} buf; })'
        % (table, OBSERVER_MASK_OFF, OBSERVER_BLOCK_OFF, BLOCK_INVOKE_OFF)
    )
    v = frame.EvaluateExpression(expr, opts)
    buf = v.GetValueAsUnsigned()
    if not buf:
        print('in-target read failed: %s' % v.GetError(), file=result)
        return
    n = process.ReadPointerFromMemory(buf, err)
    vals = struct.unpack('<%dQ' % (n * 3 + 1), process.ReadMemory(buf, n * 24 + 8, err))
    hist = collections.Counter()
    for i in range(n):
        mask, invoke = vals[2 + i * 3], vals[3 + i * 3]
        hist[(mask, _sym(target, invoke) if invoke else '?')] += 1
    print('pid %d: %d NSEvent local monitors' % (process.GetProcessID(), n), file=result)
    for (mask, sym), c in hist.most_common():
        print('%8d  mask=0x%-16x %s' % (c, mask, sym), file=result)


def __lldb_init_module(debugger, internal_dict):
    debugger.HandleCommand('command script add -f %s.nsevent_monitors nsevent-monitors' % __name__)


if __name__ == '__main__':
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        print(__doc__)
        sys.exit(2)
    os.execvp('lldb', [
        'lldb', '-p', sys.argv[1], '--batch',
        '-o', 'command script import %s' % os.path.abspath(__file__),
        '-o', 'nsevent-monitors',
        '-o', 'process detach',
    ])
