import { z } from 'zod';
import { ROLES } from './permissions';

export const USER_PAGE_SIZE_DEFAULT = 25;
export const USER_PAGE_SIZE_MAX = 100;

const normalizedEmail = z
  .email('Enter a valid email address')
  .max(320)
  .transform((value) => value.trim().toLowerCase());

const trimmedFullName = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, 'Full name is required')
      .max(120, 'Full name must be 120 characters or fewer'),
  );

const optionalDepartmentId = z.uuid().nullable().optional();

const requireDepartmentForManager = (
  value: { departmentId?: string | null; role?: (typeof ROLES)[number] },
  context: z.RefinementCtx,
) => {
  if (value.role === 'DEPT_MANAGER' && !value.departmentId) {
    context.addIssue({
      code: 'custom',
      message: 'Department managers must be assigned to a department',
      path: ['departmentId'],
    });
  }
};

export const inviteUserSchema = z
  .object({
    departmentId: optionalDepartmentId,
    email: normalizedEmail,
    fullName: trimmedFullName,
    role: z.enum(ROLES),
  })
  .strict()
  .superRefine(requireDepartmentForManager);

export const updateUserSchema = z
  .object({
    departmentId: optionalDepartmentId,
    fullName: trimmedFullName.optional(),
    role: z.enum(ROLES).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required')
  .superRefine(requireDepartmentForManager);

const optionalQueryBoolean = z.preprocess((value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean().optional());

const optionalQueryString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().optional(),
);

export const listUsersQuerySchema = z
  .object({
    active: optionalQueryBoolean,
    departmentId: z.preprocess((value) => (value === '' ? undefined : value), z.uuid().optional()),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(USER_PAGE_SIZE_MAX)
      .default(USER_PAGE_SIZE_DEFAULT),
    role: z.preprocess((value) => (value === '' ? undefined : value), z.enum(ROLES).optional()),
    search: optionalQueryString.pipe(z.string().max(120).optional()),
  })
  .strict();

export const userIdParamsSchema = z.object({ id: z.uuid() }).strict();

export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export type ManagedDepartment = {
  code: string;
  id: string;
  name: string;
};

export type ManagedUser = {
  department: ManagedDepartment | null;
  email: string;
  fullName: string;
  id: string;
  isActive: boolean;
  lastLoginAt: string | null;
  role: (typeof ROLES)[number];
};

export type ManagedUserPage = {
  items: ManagedUser[];
  page: number;
  pageSize: number;
  total: number;
};
