import { z } from "zod";

/** 环境变量名只允许普通 shell 标识符，避免模型构造异常 key 影响子进程环境。 */
export const SAFE_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 任意传给工具或子进程的文本都不能含空字节，避免底层文件和进程 API 截断。 */
export const stringWithoutNullByteSchema = z.string().refine((value) => !value.includes("\0"), {
  message: "must not contain a null byte",
});

/** 工作区路径必须有可见字符，并提前排除空字节。 */
export const pathInputSchema = stringWithoutNullByteSchema.refine((value) => value.trim().length > 0, {
  message: "must be a non-empty string",
});

/** 命令名、cwd 和 npm script 不允许换行，避免审批预览和实际 argv 边界不一致。 */
export const singleLineTextSchema = pathInputSchema.refine((value) => !value.includes("\r") && !value.includes("\n"), {
  message: "must not contain line breaks",
});

export const argsInputSchema = z.array(stringWithoutNullByteSchema);

export const envInputSchema = z.record(
  z.string().regex(SAFE_ENV_KEY_PATTERN, "must match safe environment key pattern"),
  stringWithoutNullByteSchema,
);
