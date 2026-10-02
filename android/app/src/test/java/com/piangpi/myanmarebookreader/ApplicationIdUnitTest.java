package com.piangpi.myanmarebookreader;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class ApplicationIdUnitTest {
    @Test
    public void applicationIdMatchesTheReaderPackage() {
        assertEquals("com.piangpi.myanmarebookreader", BuildConfig.APPLICATION_ID);
    }
}
