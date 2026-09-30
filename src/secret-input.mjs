export function readHiddenInput(
  prompt = "JEV API key: ",
  { stdin = process.stdin, stdout = process.stdout } = {},
) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      reject(new Error("hidden input requires an interactive terminal"));
      return;
    }

    let value = "";

    stdout.write(prompt);

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }

        if (character === "\u0003") {
          cleanup();
          stdout.write("\n");
          reject(new Error("input cancelled"));
          return;
        }

        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);

            stdout.write("\b \b");
          }

          continue;
        }

        value += character;

        stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}
