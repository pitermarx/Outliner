INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
) VALUES (
    '00000000-0000-0000-0000-000000000000',
    '6d7b1ecc-2af7-4063-a7d0-04b1ba8b1ce7',
    'authenticated',
    'authenticated',
    'tester@virgulas.com',
    crypt('virgulas', gen_salt('bf')),
    NOW(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    NOW(),
    NOW()
) ON CONFLICT (id) DO NOTHING;
