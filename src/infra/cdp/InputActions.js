const KEY_DEFINITIONS = {
  Enter: {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  },
  x: {
    key: "x",
    code: "KeyX",
    windowsVirtualKeyCode: 88,
    nativeVirtualKeyCode: 88,
    text: "x",
    unmodifiedText: "x",
  },
  ArrowDown: {
    key: "ArrowDown",
    code: "ArrowDown",
    windowsVirtualKeyCode: 40,
    nativeVirtualKeyCode: 40,
  },
  ArrowUp: {
    key: "ArrowUp",
    code: "ArrowUp",
    windowsVirtualKeyCode: 38,
    nativeVirtualKeyCode: 38,
  },
};

export async function pressKey(session, keyName) {
  const definition = KEY_DEFINITIONS[keyName];
  if (!definition) {
    throw new Error(`不支持的按键: ${keyName}`);
  }

  await session.send("Input.dispatchKeyEvent", {
    ...definition,
    type: "keyDown",
  });
  await session.send("Input.dispatchKeyEvent", {
    ...definition,
    type: "keyUp",
  });
}

export async function clickAt(session, x, y) {
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

export async function wheelAt(session, x, y, deltaY, deltaX = 0) {
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX,
    deltaY,
  });
}
