package xyz.lumptools.wallet;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyStore;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * What only this phone holds (src/core/device.ts): small secrets of the wallet page, kept so that a copy of the
 * app's files is worth nothing without the phone itself.
 *
 * A value is encrypted with a key that lives in the Android Keystore and cannot be taken out of it (on phones with
 * the hardware for it, it never leaves that hardware), and only the encrypted value is written to the app's own
 * settings file. The app's files are not in any backup or device transfer (the manifest switches both off). So what
 * is in the files can be read back only on this phone, by this app.
 *
 * The page keeps the wallet's DEVICE KEY here: the second lock on the recovery phrase, next to the PIN. Before this
 * plugin existed the page kept that key in the web view's own store, beside the data it locks.
 *
 * Deliberately not asked of the Keystore: "only while the phone is unlocked" and StrongBox. Both have a history of
 * keys that stop working on some phones, and a device key that stops working means restoring from the 24 words.
 *
 * Fingerprint or face unlock is not built yet: biometry() says so, and the page then shows no switch for it.
 */
@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "lump.securestore.v1";
    private static final String PREFS = "lump.securestore";
    private static final String CIPHER = "AES/GCM/NoPadding";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    /** a value is a key or a short secret, never bulk data */
    private static final int MAX_VALUE = 4096;
    private static final int MAX_NAME = 64;

    private final Object lock = new Object();

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The Keystore key, or null when this phone has none (yet, or any more). */
    private SecretKey existingKey() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        KeyStore.Entry entry = store.getEntry(ALIAS, null);
        return entry instanceof KeyStore.SecretKeyEntry ? ((KeyStore.SecretKeyEntry) entry).getSecretKey() : null;
    }

    private SecretKey keyForWriting() throws Exception {
        SecretKey key = existingKey();
        if (key != null) return key;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(
            new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return generator.generateKey();
    }

    private static String nameOf(PluginCall call) {
        String name = call.getString("key");
        if (name == null || name.isEmpty() || name.length() > MAX_NAME || !name.matches("[A-Za-z0-9._-]+")) return null;
        return name;
    }

    /** get({ key }) -> { value }: the value, or null when nothing is kept under that name on this phone. */
    @PluginMethod
    public void get(PluginCall call) {
        String name = nameOf(call);
        if (name == null) {
            call.reject("a name is needed");
            return;
        }
        synchronized (lock) {
            try {
                JSObject out = new JSObject();
                String stored = prefs().getString(name, null);
                if (stored == null) {
                    out.put("value", JSObject.NULL);
                    call.resolve(out);
                    return;
                }
                SecretKey key = existingKey();
                // The encrypted value is here but its key is not: the files came from another phone, or the system
                // dropped the key. Nothing can open it any more, which is "none" to the page (it then asks for the
                // 24 words), not a fault to try again later.
                if (key == null) {
                    out.put("value", JSObject.NULL);
                    call.resolve(out);
                    return;
                }
                byte[] raw = Base64.decode(stored, Base64.NO_WRAP);
                if (raw.length <= IV_BYTES) {
                    out.put("value", JSObject.NULL);
                    call.resolve(out);
                    return;
                }
                Cipher cipher = Cipher.getInstance(CIPHER);
                cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, raw, 0, IV_BYTES));
                // the name is bound in: a value cannot be moved under another name
                cipher.updateAAD(name.getBytes("UTF-8"));
                byte[] plain;
                try {
                    plain = cipher.doFinal(raw, IV_BYTES, raw.length - IV_BYTES);
                } catch (AEADBadTagException notOurs) {
                    // written under another key (another phone's files): the same "none"
                    out.put("value", JSObject.NULL);
                    call.resolve(out);
                    return;
                }
                out.put("value", new String(plain, "UTF-8"));
                java.util.Arrays.fill(plain, (byte) 0);
                call.resolve(out);
            } catch (Exception e) {
                // the Keystore itself has a problem: the page must not take that for "nothing is kept"
                call.reject("the key store could not be read: " + e.getClass().getSimpleName());
            }
        }
    }

    /** set({ key, value }): kept from now on, written before this answers. */
    @PluginMethod
    public void set(PluginCall call) {
        String name = nameOf(call);
        String value = call.getString("value");
        if (name == null || value == null || value.length() > MAX_VALUE) {
            call.reject("a name and a short value are needed");
            return;
        }
        synchronized (lock) {
            try {
                Cipher cipher = Cipher.getInstance(CIPHER);
                cipher.init(Cipher.ENCRYPT_MODE, keyForWriting());
                cipher.updateAAD(name.getBytes("UTF-8"));
                byte[] iv = cipher.getIV();
                byte[] sealed = cipher.doFinal(value.getBytes("UTF-8"));
                if (iv == null || iv.length != IV_BYTES) throw new IllegalStateException("unexpected nonce");
                byte[] raw = new byte[IV_BYTES + sealed.length];
                System.arraycopy(iv, 0, raw, 0, IV_BYTES);
                System.arraycopy(sealed, 0, raw, IV_BYTES, sealed.length);
                // commit, not apply: the page reads the value back before it relies on it
                if (!prefs().edit().putString(name, Base64.encodeToString(raw, Base64.NO_WRAP)).commit()) throw new IllegalStateException("not written");
                call.resolve();
            } catch (Exception e) {
                call.reject("the key store could not keep the value: " + e.getClass().getSimpleName());
            }
        }
    }

    /** remove({ key }) */
    @PluginMethod
    public void remove(PluginCall call) {
        String name = nameOf(call);
        if (name == null) {
            call.reject("a name is needed");
            return;
        }
        synchronized (lock) {
            prefs().edit().remove(name).commit();
        }
        call.resolve();
    }

    /** biometry() -> { kind }: fingerprint or face unlock is not built on Android yet. */
    @PluginMethod
    public void biometry(PluginCall call) {
        JSObject out = new JSObject();
        out.put("kind", "none");
        call.resolve(out);
    }

    @PluginMethod
    public void setBio(PluginCall call) {
        call.unavailable("fingerprint or face unlock is not built on Android yet");
    }

    /** Nothing is ever kept behind a fingerprint here: "none", not "cancelled". */
    @PluginMethod
    public void getBio(PluginCall call) {
        JSObject out = new JSObject();
        out.put("value", JSObject.NULL);
        call.resolve(out);
    }

    @PluginMethod
    public void removeBio(PluginCall call) {
        call.resolve();
    }
}
