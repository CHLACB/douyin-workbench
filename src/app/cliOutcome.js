export function actionExitCode(result) {
  return result?.ok === false ? 1 : 0;
}
